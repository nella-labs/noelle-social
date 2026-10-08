import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listActiveOrPausedLinkedinInternInstances, isWorkerEnabled } from "../lib/activation.js";
import { effectiveDraftsCap, enforceGoal } from "../lib/goal.js";
import { recordRun } from "../lib/worker-runs.js";
import { busForInstance } from "../lib/bus.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { createSecretsClient, APIFY_TOKEN_SECRET_ID } from "../lib/secrets.js";
import { withinActiveHours } from "../lib/cadence.js";
import { ApifyError } from "@noelle/linkedin-apify";
import { checkApifyAccountUsage } from "@noelle/runtime/apify-usage";
import { saveApifyUsage } from "@noelle/runtime/apify-usage-db";
import { AllApifyTokensExhaustedError } from "../lib/apify-rotating.js";
import {
  listApifyTokensForHealthSweep,
  markApifyTokenInvalid, pruneInvalidApifyTokens,
} from "../lib/connections-db.js";
import {
  sweepApifyTokenHealth,
  createThrottledApifyHealthSweep,
} from "../lib/apify-health-sweep.js";
import { createNotifier } from "@noelle/runtime/notifier";
import { getWatchlistPeople, getLinkedinKeywords } from "../lib/watchlist-db.js";
import {
  countExtractedToday,
  countLeadBacklogForInstance,
  countPendingApprovalsForInstance,
  upsertDiscoveredLead,
} from "../lib/leads-db.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { runDiscoveryTick } from "./discovery-tick.js";
import { resolveLinkedinDiscovery } from "../lib/discovery-config.js";
import { IcpConfigSchema } from "@noelle/contracts";
import { upsertDiscoveredPerson } from "../lib/discovered-db.js";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createApifyPoolResolver } from "../lib/apify-resolver.js";
import { shardRoundRobin, splitBudget, shardStaggerDelayMs, runWithConcurrency, plannedShardCount } from "../lib/shard.js";
import { searchExtractCeiling, searchLanesExhausted } from "../lib/discovery-budget.js";
import { createRepollGate, type RepollGate } from "@noelle/runtime/repoll-cooldown";

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

async function main() {
  const env = loadEnv();
  const log = createLogger({ kind: "discovery", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });
  const recorder = createPgSpendRecorder(sql);
  const notifier = createNotifier({ secrets, log });
  // Ping the operator once per exhaustion episode, not every 15-min tick while
  // the token pool is dry. Reset the moment a tick fetches successfully again.
  let apifyExhaustedNotified = false;

  // Apify posts transport (no LinkedIn cookies). Tokens come from the org's
  // ACTIVE noelle.connections rows (set/rotated live in the dashboard), falling
  // back to env/SM. The POOL resolver returns one client per AVAILABLE token so
  // discovery can shard its watchlist people + keyword queries across them and
  // fetch CONCURRENTLY — N tokens ≈ N× the search throughput. A single-token
  // setup yields a 1-element pool (identical to the old single-client path).
  const resolvePool = createApifyPoolResolver({
    sql,
    secrets,
    apifyTokenSecretId: APIFY_TOKEN_SECRET_ID,
    profilePostsActorId: env.APIFY_PROFILE_POSTS_ACTOR_ID,
    log,
  });

  // Proactive token-health sweep: periodically probe every active Apify token and
  // retire the definitively-dead (401) ones, closing the gap where a parked spare
  // or a capped-then-died token never gets probed by the reactive path. Throttled
  // per-org (default 1h) so it runs at most once however many instances tick. It
  // mutates the SHARED noelle.connections pool, so Lyra's worker keeps it clean for
  // every intern. Fully fail-open — never lets a probe break a discovery tick.
  const runHealthSweep = createThrottledApifyHealthSweep({
    intervalMs: env.LINKEDIN_APIFY_HEALTH_SWEEP_INTERVAL_MS,
    run: (orgId) =>
      sweepApifyTokenHealth({
        sql,
        orgId,
        listTokens: listApifyTokensForHealthSweep,
        checkToken: checkApifyAccountUsage,
        persistUsage: saveApifyUsage,
        markInvalid: markApifyTokenInvalid,
        // Retire confirmed-dead tokens from rotation while retaining their expenses.
        pruneInvalid: pruneInvalidApifyTokens,
        concurrency: env.NOELLE_APIFY_MAX_CONCURRENCY,
        log,
      }),
  });
  const maybeSweepTokenHealth = async (orgId: string): Promise<void> => {
    if (!env.LINKEDIN_APIFY_HEALTH_SWEEP_ENABLED) return;
    try {
      await runHealthSweep(orgId);
    } catch (err) {
      log.warn({ orgId, err: (err as Error).message }, "apify health sweep failed (non-fatal)");
    }
  };

  const boot = await runBootChecks({
    log,
    checks: [
      { name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } },
    ],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  log.info({}, "linkedin discovery worker ready");
  const shouldStop = installShutdown(log);

  // WATCH-lane per-person re-poll cooldown (LINKEDIN_WATCHLIST_REPOLL_HOURS).
  // One gate per instance, held across ticks for the process lifetime; shards
  // share the instance's gate (each person lands in exactly one shard, so
  // concurrent shards never contend on a key). Restart = one extra full sweep.
  const repollGates = new Map<string, RepollGate>();
  const repollGateFor = (instanceId: string): RepollGate => {
    let gate = repollGates.get(instanceId);
    if (!gate) {
      gate = createRepollGate(env.LINKEDIN_WATCHLIST_REPOLL_HOURS * 3_600_000);
      repollGates.set(instanceId, gate);
    }
    return gate;
  };

  await runWorkerLoop({
    log,
    kind: "discovery",
    pollMs: env.DISCOVERY_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: async () => {
      const instances = await listActiveOrPausedLinkedinInternInstances(sql);
      runHealthSweep.reconcileOrganizations(instances.map(instance => instance.org_id));
      return instances;
    },
    onTick: async (inst) => {
      // Other workers still use the shared Apify pool for enrichment and
      // context, so keep its health sweep even when reply sourcing is off.
      await maybeSweepTokenHealth(inst.org_id);
      if (!env.LINKEDIN_APIFY_REPLY_LEADS) {
        log.debug({ instance: inst.id }, "Apify reply-lead sourcing disabled; browser discovery remains active");
        return;
      }
      // Two lanes (parallel to Vega's x-intern):
      //   - WATCH lane  (watchlist_enabled): re-read the watched connections'
      //     posts. Always-on — runs even while paused and BYPASSES the goal +
      //     backpressure caps, so Lyra keeps replying to her network after a goal
      //     reaches/stalls + auto-pauses.
      //   - SEARCH lane (active + discovery_enabled): keyword-search LinkedIn-wide
      //     for high-engagement posts from OUTSIDE the network. Active-only and
      //     gated by the goal + inbox/backlog backpressure.
      // The dashboard's "Watchlist" toggle drives the watch lane; "Discovery"
      // drives the search lane (its label is "finds new posts to reply to").
      const active = inst.status !== "paused";
      const watchlistLaneOn = isWorkerEnabled(inst, "watchlist");
      const keywordLaneOn = active && isWorkerEnabled(inst, "discovery");
      if (!watchlistLaneOn && !keywordLaneOn) {
        log.debug({ instance: inst.id }, "discovery: both lanes off; skipping");
        return;
      }
      // Human-hours gate: don't touch LinkedIn at 3am in a tight loop.
      if (!withinActiveHours(env)) {
        log.debug({ instance: inst.id }, "outside active hours; skipping linkedin discovery");
        return;
      }
      const bus = busForInstance(inst);
      const run = await recordRun({ sql, kind: "discovery", bus });
      try {
        // The SEARCH lane respects the goal auto-pause + inbox/backlog
        // backpressure; when any trips we fall back to watch-only (the watched
        // connections still get swept). `watchlistOnly` also covers the paused /
        // discovery-off case (no search lane at all).
        let watchlistOnly = !keywordLaneOn;
        if (keywordLaneOn) {
          const goal = await enforceGoal(sql, inst, { stallMs: env.LINKEDIN_GOAL_STALL_MIN * 60_000 });
          let keywordBlocked = Boolean(goal?.paused);
          if (goal?.paused) {
            log.info(
              { org_id: inst.org_id, produced: goal.produced, target: goal.target, stalled: goal.stalled },
              goal.stalled
                ? "goal stalled — search lane paused (watch lane continues)"
                : "goal reached — search lane paused (watch lane continues)",
            );
          }
          if (!keywordBlocked) {
            const cap = effectiveDraftsCap(inst);
            if (cap != null) {
              const pending = await countPendingApprovalsForInstance(sql, inst.id);
              if (pending >= cap) {
                keywordBlocked = true;
                log.info({ org_id: inst.org_id, pending, cap }, "search lane paused: pending approvals at cap");
              }
            }
          }
          if (!keywordBlocked && inst.lead_backlog_cap != null) {
            const backlog = await countLeadBacklogForInstance(sql, inst.id);
            if (backlog >= inst.lead_backlog_cap) {
              keywordBlocked = true;
              log.info(
                { org_id: inst.org_id, backlog, cap: inst.lead_backlog_cap },

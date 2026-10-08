import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listWatchlistOrActiveXInternInstances, isWorkerEnabled } from "../lib/activation.js";
import { effectiveDraftsCap, enforceGoal } from "../lib/goal.js";
import { recordRun } from "../lib/worker-runs.js";
import { busForInstance } from "../lib/bus.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { createSecretsClient, APIFY_TOKEN_SECRET_ID } from "../lib/secrets.js";
// Sharding (from main) + the health sweep and person-first lane (this branch).
import { createApifyShardResolver } from "../lib/apify-shard-resolver.js";
import {
  shardRoundRobin,
  shardStaggerDelayMs,
  runWithConcurrency,
  icpGateConfigured,
} from "@noelle/runtime";
import {
  sweepApifyTokenHealth,
  createThrottledApifyHealthSweep,
} from "@noelle/runtime/apify-health-sweep";
import { listApifyTokensForHealthSweep, markApifyTokenInvalid, pruneInvalidApifyTokens } from "../lib/connections-db.js";
import { checkApifyAccountUsage } from "@noelle/runtime/apify-usage";
import { saveApifyUsage } from "@noelle/runtime/apify-usage-db";
import { readIcpGate } from "../lib/icp-config.js";
import { withinActiveHours } from "../lib/cadence.js";
import { searchLanesExhausted, dailyCapReached } from "../lib/discovery-budget.js";
import { countExtractedToday } from "../lib/leads-db.js";
import {
  pickSeeds,
  readSeedHandles,
  runFollowerFeeder,
  isFeederDue,
} from "../lib/follower-feeder.js";
import { X_FOLLOWER_ACTOR } from "@noelle/x-apify";
import {
  upsertDiscoveredPerson,
  listPeopleToPoll,
  markPersonPolled,
} from "../lib/discovered-db.js";
import { AllApifyTokensExhaustedError } from "../lib/apify-rotating.js";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createRateBucket } from "../lib/rate-bucket.js";
import { getWatchlist, getWatchlistPeople } from "../lib/watchlist.js";
import {
  countLeadBacklogForInstance,
  countPendingApprovalsForInstance,
  upsertDiscoveredLead,
} from "../lib/leads-db.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { runDiscoveryTick } from "./discovery-tick.js";
import { promoteWatchlistAuthors } from "../lib/watchlist-promote.js";
import { createRepollGate, type RepollGate } from "@noelle/runtime/repoll-cooldown";
import { createSourceCursorRegistry } from "../lib/source-cursor.js";
import { createNotifier } from "@noelle/runtime/notifier";
import { withMeteredApifyCall } from "../lib/apify-receipts.js";

// Auto-promote is a cheap query but there's no need to run it every discovery
// tick — throttle to at most hourly per instance. Module scope so the cooldown
// survives across ticks; it resets on worker restart, which is harmless.
const PROMOTE_INTERVAL_MS = 60 * 60_000;
const lastPromoteAt = new Map<string, number>();

// WATCH-lane per-person re-poll cooldown (X_WATCHLIST_REPOLL_HOURS, default 2h;
// 0 = off). One gate per instance, held across ticks for the process lifetime —
// same module-scope lifecycle as lastPromoteAt above. Restart = one extra full
// sweep. Ported from Lyra (#441).
const repollGates = new Map<string, RepollGate>();

// Rotation cursors: where in the source ring the next tick starts, so a
// budget- or rate-truncated tick resumes at the first deferred source instead
// of restarting at the head — which starved the tail of the watchlist AND the
// whole keyword lane once #494's time budget landed. Keyed per (instance,
// mode) because full-mode and watchlist-only ticks iterate different rings
// (see source-cursor.ts). Module scope like repollGates.
const sourceCursors = createSourceCursorRegistry();

async function main() {
  const env = loadEnv();
  const log = createLogger({ kind: "discovery", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });
  // Pages the operator when the Apify pool goes fully dead (see the
  // AllApifyTokensExhaustedError handler below) — otherwise discovery stops
  // silently and the only symptom is an approvals queue that drains to zero.
  const notifier = createNotifier({ secrets, log });

  // Proactive Apify-token health sweep, throttled to once per interval per org.
  // Lyra hosts one too; both mutate the SHARED noelle.connections pool, and
  // hosting it in one worker only left the pool unprobed exactly when that
  // worker was down. Fully fail-open — a probe must never break a discovery tick.
  const runHealthSweep = createThrottledApifyHealthSweep({
    intervalMs: env.X_APIFY_HEALTH_SWEEP_INTERVAL_MS,
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
        concurrency: env.X_APIFY_HEALTH_SWEEP_CONCURRENCY,
        log,
      }),
  });
  const maybeSweepTokenHealth = async (orgId: string): Promise<void> => {
    if (!env.X_APIFY_HEALTH_SWEEP_ENABLED) return;
    await runHealthSweep(orgId).catch((err) =>
      log.warn({ orgId, err: (err as Error).message }, "apify health sweep failed (ignored)"),
    );
  };
  // Once-per-episode latch for the pool-dead page. Discovery ticks every
  // DISCOVERY_POLL_MS, and an exhausted pool stays exhausted for hours, so
  // without this the operator's phone buzzes on every tick until a token frees
  // up. Reset after the next successful tick so the NEXT outage still pages.
  let apifyExhaustedNotified = false;
  const recorder = createPgSpendRecorder(sql);
  // Per-org Apify token resolver (hot-swap + multi-token rotation over the shared
  // 'apify' pool). X reads run through Apify (see X_SCRAPER_ACTOR_ID in @noelle/x-apify), not
  // bird cookies — no X login, so discovery can't lock the account. Writes (send)
  // still use bird cookies; this resolver is read-only.
  const resolveApifyShards = createApifyShardResolver({
    sql,
    secrets,
    apifyTokenSecretId: APIFY_TOKEN_SECRET_ID,
    // Tighter per-run timeout so a stuck/queued free-tier Apify run is abandoned
    // sooner instead of burning the x-apify 120s default on a run that never ends.
    apifyTimeoutMs: env.X_DISCOVERY_APIFY_TIMEOUT_MS,
    log,
  });

  const boot = await runBootChecks({
    log,
    checks: [
      { name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } },
    ],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  log.info({}, "discovery worker ready");
  const shouldStop = installShutdown(log);
  const bucket = createRateBucket({ tokens: env.X_RATE_TOKENS, windowMs: env.X_RATE_WINDOW_MS });

  // One re-poll gate per instance (cooldown 0 ⇒ due() is always true — the gate
  // is inert and behaviour is byte-identical to today).
  const repollGateFor = (instanceId: string): RepollGate => {
    let gate = repollGates.get(instanceId);
    if (!gate) {
      gate = createRepollGate(env.X_WATCHLIST_REPOLL_HOURS * 3_600_000);
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
      const instances = await listWatchlistOrActiveXInternInstances(sql);
      runHealthSweep.reconcileOrganizations(instances.map(instance => instance.org_id));
      return instances;
    },
    onTick: async (inst) => {
      // The shared token pool still serves enrichment and comment context.
      await maybeSweepTokenHealth(inst.org_id);
      if (!env.X_APIFY_REPLY_LEADS) {
        log.debug({ instance: inst.id }, "Apify reply-lead sourcing disabled; browser discovery remains active");
        return;
      }
      // Two lanes: the watchlist lane (poll watched-people handles → priority
      // leads) is always-on while watchlist_enabled and bypasses the goal +
      // backpressure caps; the keyword lane (targeting handles + keyword search)
      // runs only when active + discovery_enabled and respects those caps.
      const active = inst.status !== "paused";
      const watchlistLaneOn = isWorkerEnabled(inst, "watchlist");
      const keywordLaneOn = active && isWorkerEnabled(inst, "discovery");
      if (!watchlistLaneOn && !keywordLaneOn) {
        log.debug({ instance: inst.id }, "discovery: both lanes off; skipping");
        return;
      }
      const bus = busForInstance(inst);
      const run = await recordRun({ sql, kind: "discovery", bus });
      try {
        // The keyword lane is gated by the goal + backpressure caps; when any of
        // them trips we fall back to watchlist-only (the watched accounts still
        // get polled). `watchlistOnly` also covers the paused case (no keyword
        // lane at all).
        let watchlistOnly = !keywordLaneOn;
        if (keywordLaneOn) {
          const goal = await enforceGoal(sql, inst);
          let keywordBlocked = Boolean(goal?.paused);
          if (goal?.paused) {
            log.info(
              {
                org_id: inst.org_id,
                produced: goal.produced,
                target: goal.target,
                stalled: goal.stalled,
              },
              goal.stalled
                ? "goal STALLED (no new replies for the stall window) — auto-paused so it stops polling Apify; keyword lane off, watchlist lane continues"
                : "goal reached — keyword lane paused (watchlist lane continues)",
            );
          }
          if (!keywordBlocked) {
            const cap = effectiveDraftsCap(inst);
            if (cap != null) {
              const pending = await countPendingApprovalsForInstance(sql, inst.id);
              if (pending >= cap) {
                keywordBlocked = true;
                log.info({ org_id: inst.org_id, pending, cap }, "keyword lane paused: pending at cap");
              }
            }
          }
          if (!keywordBlocked && inst.lead_backlog_cap != null) {
            const backlog = await countLeadBacklogForInstance(sql, inst.id);
            if (backlog >= inst.lead_backlog_cap) {
              keywordBlocked = true;
              log.info(
                { org_id: inst.org_id, backlog, cap: inst.lead_backlog_cap },
                "keyword lane paused: lead backlog at cap",
              );
            }
          }
          if (keywordBlocked) {
            if (!watchlistLaneOn) {
              await run.finish({ status: "ok", rowsProcessed: 0 });
              return;
            }
            watchlistOnly = true;
          }
        }

        // HUMAN-HOURS GATE (read side). Scraping X round the clock is a bot
        // signal; the actuator already has a write curfew, this covers the read
        // half. START==END disables it, which is the default, so this is inert
        // until the operator sets a window.
        if (!withinActiveHours(env)) {
          log.info({ instance: inst.id }, "outside active hours — skipping discovery tick");
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }

        // DAILY EXTRACT BUDGET. One cap across all lanes, with the top band
        // reserved for the always-on WATCH lane so the high-volume keyword lane
        // cannot burn the day's Apify budget and starve the operator's
        // hand-picked accounts. Cap 0 = unlimited (default) ⇒ both checks are
        // no-ops and behaviour is byte-identical.
        const extractedToday =
          env.X_DAILY_EXTRACT_CAP > 0 ? await countExtractedToday(sql, inst.id).catch(() => 0) : 0;
        if (dailyCapReached(extractedToday, env.X_DAILY_EXTRACT_CAP)) {
          log.info(
            { instance: inst.id, extractedToday, cap: env.X_DAILY_EXTRACT_CAP },
            "daily extract cap reached — discovery paused for the day",
          );
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }
        // Inside the reserved band: the watch lane keeps drawing, the keyword
        // lane stops. Expressed by flipping the tick into watchlist-only mode,
        // which is exactly the lane split that already exists for a paused run.
        if (
          !watchlistOnly &&
          searchLanesExhausted(extractedToday, env.X_DAILY_EXTRACT_CAP, env.X_WATCHLIST_DAILY_RESERVE)
        ) {
          log.info(
            { instance: inst.id, extractedToday, reserve: env.X_WATCHLIST_DAILY_RESERVE },
            "daily budget entered the watch-lane reserve — keyword lane paused for the day",
          );
          watchlistOnly = true;
        }

        // Resolve the org's Apify tokens as N DISJOINT shards (N=1 ⇒ the plain
        // single-client path, byte-identical to before). Capped by how many
        // tokens are actually available, so a big concurrency setting on a thin
        // pool simply yields fewer shards rather than shards sharing a token.
        const shardHandles = await resolveApifyShards(
          inst.org_id,
          env.NOELLE_APIFY_MAX_CONCURRENCY,
        );
        if (shardHandles.length === 0) {
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }

        const wl = await getWatchlist(sql, inst.id);

        // Self-curating watchlist: periodically promote keyword authors with
        // multiple drafted replies into the always-on watchlist, so their future
        // posts become priority leads. Gated by WATCHLIST_AUTOPROMOTE_MAX (0
        // disables) + an hourly cooldown; only on the active keyword lane.
        // Failures never block discovery. Runs before getWatchlistPeople so any
        // promotions are polled this same tick.
        if (env.WATCHLIST_AUTOPROMOTE_MAX > 0 && !watchlistOnly) {
          const last = lastPromoteAt.get(inst.id) ?? 0;
          if (Date.now() - last >= PROMOTE_INTERVAL_MS) {
            lastPromoteAt.set(inst.id, Date.now());
            try {
              const promoted = await promoteWatchlistAuthors(sql, inst.id, inst.org_id, {
                minDrafted: env.WATCHLIST_AUTOPROMOTE_MIN_DRAFTED,
                maxPerRun: env.WATCHLIST_AUTOPROMOTE_MAX,
              });
              if (promoted.length) {
                log.info({ instance: inst.id, promoted }, "auto-promoted keyword authors to watchlist");
              }
            } catch (err) {
              log.warn(
                { instance: inst.id, err: (err as Error).message },
                "watchlist auto-promote failed",
              );
            }
          }
        }

        const people = await getWatchlistPeople(sql, inst.id);

        // One ICP reader for BOTH person lanes (feeder + retention) and the
        // classifier, so "in-ICP" cannot come to mean two different things.
        const icpGate = readIcpGate(inst.icp_config);

        // FOLLOWER FEEDER — person DISCOVERY. Harvests the audience of a seed
        // account and retains the ones whose bio matches the ICP. Default OFF
        // because, unlike every other discovery knob, this one spends per RUN
        // rather than per useful lead: the actor floors its list at 200 users
        // (~$0.03 a run), so an unthrottled loop would drain a free-tier token's
        // monthly credit in days.
        //
        // The throttle stamp lives on the BUS, not in process memory: the worker
        // restarts on every deploy tick, and an in-memory stamp would let each
        // restart re-trigger a paid run. isFeederDue treats an unreadable stamp
        // as "recently run" so a bus glitch costs nothing.
        if (env.X_FOLLOWER_FEEDER_ENABLED && !watchlistOnly && icpGateConfigured(icpGate)) {
          const stampKey = `follower_feeder:${inst.id}`;
          const state = await bus
            ?.get<{ lastRunAt?: string; cursor?: number }>("pipeline", stampKey)
            .catch(() => null);
          if (isFeederDue(state?.lastRunAt, env.X_FOLLOWER_FEEDER_INTERVAL_HOURS, new Date())) {
            const seeds = pickSeeds(
              {
                configured: readSeedHandles(inst.icp_config),
                // The watchlist PEOPLE (x_watchlist_people), not wl.handles.
                // wl.handles is the TARGETING-handle list, which is empty on the
                // live instance (54 watch people, 34 keywords, 0 targeting
                // handles) — so falling back to it would have left the feeder
                // silently seedless and spending nothing forever. The people are
                // the accounts the operator actually hand-picked, which is
                // exactly the audience worth harvesting.
                watchlist: people.map((p) => p.handle),
              },
              env.X_FOLLOWER_FEEDER_SEEDS_PER_RUN,
              state?.cursor ?? 0,
            );
            if (seeds.length > 0) {
              // Stamp BEFORE the run: a crash mid-run must not leave the feeder
              // eligible again on the very next tick, which is how a paid loop
              // starts. Worst case we skip one window.
              await bus
                ?.put("pipeline", stampKey, {
                  lastRunAt: new Date().toISOString(),
                  cursor: (state?.cursor ?? 0) + seeds.length,
                })
                .catch(() => {});
              try {
                await runFollowerFeeder({
                  sql,
                  orgId: inst.org_id,
                  agentInstanceId: inst.id,
                  icpGate: icpGate!,
                  seeds,
                  maxUsers: env.X_FOLLOWER_FEEDER_MAX_USERS,
                  scrapeFollowers: (a) => withMeteredApifyCall({
                    client: shardHandles[0]!.client, recorder, log,
                    orgId: inst.org_id, instanceId: inst.id, agentRole: "x_intern",
                    worker: "discovery", actor: X_FOLLOWER_ACTOR, startedAt: new Date(),
                    credentialId: shardHandles[0]!.credentialId,
                  }, operation => operation.scrapeFollowers(a)),
                  recordPerson: (p) =>
                    upsertDiscoveredPerson(sql, {
                      orgId: inst.org_id,
                      agentInstanceId: inst.id,
                      handle: p.handle,
                      authorId: p.id,
                      displayName: p.displayName,
                      bio: p.bio,
                      source: "follower_scrape",
                    }),
                  log,
                });
              } catch (err) {
                // A dead pool propagates (the handler pages); anything else is
                // non-fatal — the watch + keyword lanes already ran.
                if (err instanceof AllApifyTokensExhaustedError) throw err;
                log.warn(
                  { instance: inst.id, err: (err as Error).message },
                  "follower feeder failed (ignored)",
                );

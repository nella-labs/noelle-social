import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listActiveRedditInternInstances, isWorkerEnabled } from "../lib/activation.js";
import { effectiveDraftsCap, enforceGoal } from "../lib/goal.js";
import { recordRun } from "../lib/worker-runs.js";
import { busForInstance } from "../lib/bus.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { createSecretsClient, APIFY_TOKEN_SECRET_ID } from "../lib/secrets.js";
import { ApifyError } from "@noelle/reddit-apify";
import { AllApifyTokensExhaustedError } from "../lib/apify-rotating.js";
import { createNotifier } from "@noelle/runtime/notifier";
import { getWatchlistSubreddits } from "../lib/watchlist-db.js";
import {
  countExtractedToday,
  countLeadBacklogForInstance,
  countPendingApprovalsForInstance,
  upsertDiscoveredLead,
} from "../lib/leads-db.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { runDiscoveryTick } from "./discovery-tick.js";
import { resolveRedditDiscovery } from "../lib/discovery-config.js";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createApifyPoolResolver } from "../lib/apify-resolver.js";
import { shardRoundRobin, splitBudget, shardStaggerDelayMs, runWithConcurrency, plannedShardCount } from "../lib/shard.js";
import { createRepollGate, type RepollGate } from "@noelle/runtime/repoll-cooldown";

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

async function main() {
  const env = loadEnv();
  const log = createLogger({ kind: "discovery", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });
  const recorder = createPgSpendRecorder(sql);
  const notifier = createNotifier({ secrets, log });
  // Ping the operator once per exhaustion episode, not every tick while the token
  // pool is dry. Reset the moment a tick fetches successfully again.
  let apifyExhaustedNotified = false;

  // Apify posts transport (no Reddit login). Tokens come from the org's ACTIVE
  // noelle.connections rows (set/rotated live in the dashboard), falling back to
  // env/SM. The POOL resolver returns one client per AVAILABLE token so discovery
  // can shard its subreddits across them and fetch CONCURRENTLY. A single-token
  // setup yields a 1-element pool (identical to the old single-client path).
  const resolvePool = createApifyPoolResolver({
    sql,
    secrets,
    apifyTokenSecretId: APIFY_TOKEN_SECRET_ID,
    subredditPostsActorId: env.APIFY_SUBREDDIT_POSTS_ACTOR_ID,
    log,
  });

  const boot = await runBootChecks({
    log,
    checks: [
      { name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } },
    ],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  log.info({}, "reddit discovery worker ready");
  const shouldStop = installShutdown(log);

  // Per-subreddit re-poll cooldown (REDDIT_WATCHLIST_REPOLL_HOURS; 0 = off).
  // One gate per instance, held across ticks for the process lifetime; shards
  // share the instance's gate (each subreddit lands in exactly one shard, so
  // concurrent shards never contend on a key). Restart = one extra full sweep.
  const repollGates = new Map<string, RepollGate>();
  const repollGateFor = (instanceId: string): RepollGate => {
    let gate = repollGates.get(instanceId);
    if (!gate) {
      gate = createRepollGate(env.REDDIT_WATCHLIST_REPOLL_HOURS * 3_600_000);
      repollGates.set(instanceId, gate);
    }
    return gate;
  };

  await runWorkerLoop({
    log,
    kind: "discovery",
    pollMs: env.REDDIT_DISCOVERY_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listActiveRedditInternInstances(sql),
    onTick: async (inst) => {
      // Orion's single discovery lane sweeps each watched subreddit's recent posts.
      // Unlike Vega/Lyra (whose watchlist is priority *people* kept always-on while
      // paused), Orion's watchlist is *subreddits* and is its only lane — so a
      // paused instance has nothing to keep doing. Pausing puts the whole pipeline
      // to sleep: the loop only ever sees ACTIVE instances. When active, the goal
      // auto-pause + inbox/backlog backpressure and the daily extract cap gate it.
      const watchlistLaneOn = isWorkerEnabled(inst, "watchlist");
      if (!watchlistLaneOn) {
        log.debug({ instance: inst.id }, "discovery: watchlist lane off; skipping");
        return;
      }
      const bus = busForInstance(inst);
      const run = await recordRun({ sql, kind: "discovery", bus });
      try {
        // Respect the goal auto-pause + inbox/backlog backpressure; when any trips,
        // discovery stops this tick — there is no second lane to fall back to.
        if (isWorkerEnabled(inst, "discovery")) {
          const goal = await enforceGoal(sql, inst, { stallMs: env.REDDIT_GOAL_STALL_MIN * 60_000 });
          if (goal?.paused) {
            log.info(
              { org_id: inst.org_id, produced: goal.produced, target: goal.target, stalled: goal.stalled },
              goal.stalled ? "goal stalled — discovery paused this tick" : "goal reached — discovery paused this tick",
            );
            await run.finish({ status: "ok", rowsProcessed: 0 });
            return;
          }
          const cap = effectiveDraftsCap(inst);
          if (cap != null) {
            const pending = await countPendingApprovalsForInstance(sql, inst.id);
            if (pending >= cap) {
              log.info({ org_id: inst.org_id, pending, cap }, "discovery paused: pending approvals at cap");
              await run.finish({ status: "ok", rowsProcessed: 0 });
              return;
            }
          }
          if (inst.lead_backlog_cap != null) {
            const backlog = await countLeadBacklogForInstance(sql, inst.id);
            if (backlog >= inst.lead_backlog_cap) {
              log.info({ org_id: inst.org_id, backlog, cap: inst.lead_backlog_cap }, "discovery paused: lead backlog at cap");
              await run.finish({ status: "ok", rowsProcessed: 0 });
              return;
            }
          }
        }

        // Daily extract cap: how many posts this instance has already extracted
        // today. Discovery stops once the day's running total reaches the cap so
        // the classifier backlog never balloons. A cost/safety cap (not a goal).
        const alreadyExtractedToday = await countExtractedToday(sql, inst.id);
        if (alreadyExtractedToday >= env.REDDIT_DAILY_EXTRACT_CAP) {
          log.info(
            { org_id: inst.org_id, alreadyExtractedToday, cap: env.REDDIT_DAILY_EXTRACT_CAP },
            "discovery paused: daily extract cap reached",
          );
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }

        const subreddits = await getWatchlistSubreddits(sql, inst.id);
        if (subreddits.length === 0) {
          log.info({ instance: inst.id }, "nothing to discover this tick (no watched subreddits)");
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }

        const pool = await resolvePool(inst.org_id);
        if (pool.length === 0) {
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }
        // Tailored run: the operator's saved default + active per-run override.
        // postsPerSource sets the Apify fetch size; the window rides along.
        const filters = resolveRedditDiscovery(inst, {
          defaultPostsPerSource: env.REDDIT_DISCOVERY_LIMIT,
        });

        // Shard the subreddits across the token pool and fetch concurrently. Each
        // subreddit lands in exactly one shard, so two tokens never fetch the same
        // subreddit. The daily cap is split across shards (no shared-counter race).
        // A single-token pool collapses to one shard = old behaviour.
        const n = pool.length;
        const remainingCap = Math.max(0, env.REDDIT_DAILY_EXTRACT_CAP - alreadyExtractedToday);
        // Never launch more shards than there is budget for: splitBudget would
        // hand the surplus shards a 0 budget, and a 0-budget shard strands the
        // subreddits round-robined onto it for the whole day. When remainingCap
        // >= token count this is a no-op (shardCount === n, unchanged behaviour).
        const shardCount = plannedShardCount(n, remainingCap);
        if (shardCount === 0) {
          // Daily extract cap already spent — nothing to fetch until midnight.
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }
        const subredditShards = shardRoundRobin(subreddits, shardCount);
        const capShards = splitBudget(remainingCap, shardCount);

        const runShard = async (i: number) => {
          // Stagger the launch so the N shards don't all hit Apify at the same
          // instant from one residential IP (the cohort-ban trigger). Concurrent
          // overall; only the starts are spread.
          await sleep(shardStaggerDelayMs(i, env.NOELLE_APIFY_SHARD_STAGGER_MS));
          return runDiscoveryTick({
            log,
            instance: inst,
            watchlistSubreddits: subredditShards[i] ?? [],
            postsSource: pool[i]!.client,
            discoveryLimit: filters.postsPerSource,
            commentsPerPost: env.REDDIT_COMMENTS_PER_POST,
            timeWindowHours: filters.timeWindowHours,
            dailyExtractCap: capShards[i] ?? 0,
            alreadyExtractedToday: 0,
            repollGate: repollGateFor(inst.id),
            upsertLead: (a) => upsertDiscoveredLead(sql, a),
            recorder,
            credentialId: pool[i]!.credentialId,
            bus,

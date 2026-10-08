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
                "search lane paused: lead backlog at cap",
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

        // Daily extract cap: how many posts this instance has already extracted
        // today, across BOTH lanes. Discovery stops once the day's running total
        // reaches the cap so the classifier backlog never balloons. A cost/safety
        // cap (not a goal), so it applies even to the always-on watch lane.
        const alreadyExtractedToday = await countExtractedToday(sql, inst.id);
        // 0 = unlimited: treat as a very large finite ceiling so the existing
        // budget/shard arithmetic (subtract → splitBudget → per-shard compares) is
        // never actually hit — i.e. no daily cap. A positive env value re-imposes
        // the hard ceiling. MAX_SAFE_INTEGER (not Infinity) so splitBudget stays
        // finite and never yields NaN.
        const dailyExtractCap =
          env.LINKEDIN_DAILY_EXTRACT_CAP > 0 ? env.LINKEDIN_DAILY_EXTRACT_CAP : Number.MAX_SAFE_INTEGER;
        if (alreadyExtractedToday >= dailyExtractCap) {
          log.info(
            { org_id: inst.org_id, alreadyExtractedToday, cap: dailyExtractCap },
            "discovery paused: daily extract cap reached",
          );
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }

        // Reserve the top band of the daily cap for the always-on watch lane. Once
        // the day's running total reaches (cap − reserve), stop feeding the keyword
        // + profile SEARCH lanes for the rest of the day — a burst of low-value
        // search/profile leads can never eat the budget the operator's hand-picked
        // connections need. The watch lane keeps drawing to the full cap. Reuses the
        // existing watchlist-only plumbing (gates both `icp` and `keywords` below).
        if (
          !watchlistOnly &&
          searchLanesExhausted(
            alreadyExtractedToday,
            dailyExtractCap,
            env.LINKEDIN_WATCHLIST_DAILY_RESERVE,
          )
        ) {
          log.info(
            {
              org_id: inst.org_id,
              alreadyExtractedToday,
              searchCeiling: searchExtractCeiling(
                dailyExtractCap,
                env.LINKEDIN_WATCHLIST_DAILY_RESERVE,
              ),
              reserve: env.LINKEDIN_WATCHLIST_DAILY_RESERVE,
            },
            "search lanes paused: watchlist daily reserve reached (watch lane continues)",
          );
          watchlistOnly = true;
        }

        // Profile-first ICP (0043). Part of the ACTIVE search lane, so it's off
        // when watch-only (paused / discovery-off / goal-paused / backpressure).
        // When set it gates the keyword lane's authors AND enables the
        // profile-search feeder. Invalid config is ignored (logged, not fatal).
        let icp = null as ReturnType<typeof IcpConfigSchema.safeParse>["data"] | null;
        if (!watchlistOnly && inst.icp_config != null) {
          const parsed = IcpConfigSchema.safeParse(inst.icp_config);
          if (parsed.success) icp = parsed.data;
          else log.warn({ instance: inst.id, issues: parsed.error.issues }, "invalid icp_config; ignoring");
        }

        // Watch lane reads watched people (only when its lane is on); search lane
        // reads keywords (the ICP's postQueries override the saved watchlist
        // keywords when present). Any of people / keywords / icp being present is
        // enough to do work this tick.
        const people = watchlistLaneOn ? await getWatchlistPeople(sql, inst.id) : [];
        const keywords = watchlistOnly
          ? []
          : icp?.postQueries?.length
            ? icp.postQueries
            : await getLinkedinKeywords(sql, inst.id);
        if (people.length === 0 && keywords.length === 0 && !icp) {
          log.info({ instance: inst.id, watchlistOnly }, "nothing to discover this tick (no people, no keywords, no icp)");
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }

        const pool = await resolvePool(inst.org_id);
        if (pool.length === 0) {
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }
        // Tailored run: the operator's saved default + active per-run override.
        // postsPerSource sets the Apify fetch size; the window + engagement floors
        // ride along to the tick. Un-tailored instances keep the env fetch size.
        const filters = resolveLinkedinDiscovery(inst, {
          defaultPostsPerSource: env.LINKEDIN_DISCOVERY_LIMIT,
        });

        // Shard the work across the token pool and fetch concurrently. People
        // (watch lane) shard across funded tokens. Keywords shard too — UNLESS an
        // ICP is set: the ICP feeder + author gate must run together on one
        // shard, so when icp!=null the keyword lane stays on shard 0 (still
        // concurrent with the other shards' watch-lane fetches). Each
        // person/keyword lands in exactly one shard, so two tokens never fetch
        // the same target. The daily cap is split across shards (no shared-counter
        // race). A single-token pool collapses to one shard = old behaviour.
        const remainingCap = Math.max(0, dailyExtractCap - alreadyExtractedToday);
        const n = plannedShardCount(pool.length, remainingCap);
        const fundedPool = pool.slice(0, n);
        const peopleShards = shardRoundRobin(people, n);
        const keywordShards = icp ? fundedPool.map((_, i) => (i === 0 ? keywords : [])) : shardRoundRobin(keywords, n);
        const capShards = splitBudget(remainingCap, n);

        const runShard = async (i: number) => {
          const shardKeywords = keywordShards[i] ?? [];
          // Stagger the launch so the N shards don't all hit Apify at the same
          // instant from one IP. Concurrent overall; only the starts are spread.
          await sleep(shardStaggerDelayMs(i, env.NOELLE_APIFY_SHARD_STAGGER_MS));
          return runDiscoveryTick({
            log,
            instance: inst,
            watchlistPeople: peopleShards[i] ?? [],
            keywords: shardKeywords,
            keywordConfig:
              shardKeywords.length > 0
                ? {
                    searchLimit: env.LINKEDIN_KEYWORD_DISCOVERY_LIMIT,
                    minReactions: filters.minReactions ?? env.LINKEDIN_KEYWORD_MIN_REACTIONS,
                    postedLimit: env.LINKEDIN_KEYWORD_POSTED_LIMIT,
                  }
                : undefined,
            postsSource: fundedPool[i]!.client,
            discoveryLimit: filters.postsPerSource,
            filters: {
              timeWindowHours: filters.timeWindowHours,
              minReactions: filters.minReactions,
              minComments: filters.minComments,
            },
            // Per-shard slice of the daily cap, so concurrent shards never
            // collectively exceed LINKEDIN_DAILY_EXTRACT_CAP.
            dailyExtractCap: capShards[i] ?? 0,
            alreadyExtractedToday: 0,
            repollGate: repollGateFor(inst.id),
            upsertLead: (a) => upsertDiscoveredLead(sql, a),
            recorder,
            credentialId: fundedPool[i]!.credentialId,
            bus,
            // ICP feeder + author gate run on shard 0 only (once per tick).
            icp: i === 0 ? icp : null,
            recordDiscoveredPerson: (p) =>
              upsertDiscoveredPerson(sql, { orgId: inst.org_id, agentInstanceId: inst.id, ...p }),
          });
        };

        // Run shards concurrently, but with a CAP: at most
        // NOELLE_APIFY_MAX_CONCURRENCY shards in flight at once, so at most that
        // many Apify actor calls egress from this box simultaneously (firing every
        // token's shard at once is the LinkedIn-ban trigger). The per-shard stagger
        // inside runShard still spreads the starts of each capped batch. A shard
        // whose token exhausts mid-tick throws; runWithConcurrency keeps the other
        // shards' results (allSettled semantics) and we only surface the exhaustion
        // error when EVERY shard failed that way (matches the single-client path).
        const settled = await runWithConcurrency(fundedPool, env.NOELLE_APIFY_MAX_CONCURRENCY, (i) => runShard(i));
        const inserted = settled.reduce((sum, r) => sum + (r.status === "fulfilled" ? r.value : 0), 0);
        const exhaustions = settled.filter(
          (r) => r.status === "rejected" && r.reason instanceof AllApifyTokensExhaustedError,
        );
        const otherError = settled.find(
          (r) => r.status === "rejected" && !(r.reason instanceof AllApifyTokensExhaustedError),
        );
        if (otherError && otherError.status === "rejected") throw otherError.reason;
        if (exhaustions.length === settled.length && settled.length > 0) {
          throw (exhaustions[0] as PromiseRejectedResult).reason;
        }
        if (exhaustions.length > 0) {
          log.warn(
            { instance: inst.id, exhaustedShards: exhaustions.length, totalShards: settled.length },
            "some apify tokens exhausted mid-tick; remaining shards completed",
          );
        }
        await run.finish({ status: "ok", rowsProcessed: inserted });
        // A successful fetch means at least one token works again — re-arm the
        // exhaustion alert so the next episode pings.
        apifyExhaustedNotified = false;
      } catch (err) {
        // Every Apify token is spent (all rotated + 403'd). Surface it: record
        // the error so the dashboard shows "errored: …" instead of a silent
        // "stalled", and ping the operator once per episode. NOT re-thrown — a dry
        // token pool isn't a crash bug, and flapping the worker wouldn't refill it.
        if (err instanceof AllApifyTokensExhaustedError) {
          log.error({ instance: inst.id, tokens: err.tokenCount }, err.message);
          await run.finish({ status: "error", errorMessage: err.message });
          if (!apifyExhaustedNotified) {
            apifyExhaustedNotified = true;
            await notifier
              .notify({
                orgId: inst.org_id,
                title: "Lyra: Apify tokens exhausted",
                message:
                  `All ${err.tokenCount} Apify token${err.tokenCount === 1 ? "" : "s"} hit the ` +
                  `monthly usage limit — Lyra can't fetch LinkedIn posts until you add a working ` +
                  `token in Connections.`,
              })
              .catch(() => {});
          }
          return;
        }
        // Apify rate limits (429 too many runs) are transient — defer to the next
        // tick rather than flapping the worker. (402/403 are token-fatal and get
        // rotated inside the client, surfacing as AllApifyTokensExhaustedError.)
        if (err instanceof ApifyError && (err.status === 429 || err.status === 402)) {
          log.info(
            { instance: inst.id, status: err.status },
            "apify rate/usage limit; deferring to next tick",
          );
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }
        await run.finish({ status: "error", errorMessage: (err as Error).message });
        throw err;
      }
    },
    shouldStop,
  });
}

main().catch((err) => {
  console.error("discovery fatal:", err);
  process.exit(EX_TEMPFAIL);
});

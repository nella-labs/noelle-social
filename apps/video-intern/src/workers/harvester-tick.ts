import type { Sql } from "postgres";
import { VideoFeederConfigSchema } from "@noelle/contracts";
import type { HarvestRunSummary, HarvestLaneResult, HarvestPhase } from "@noelle/contracts";
import { isBudgetAdmissionError, type SpendRow } from "@noelle/runtime";
import { withMeteredApifyCall } from "@noelle/runtime/apify-metering";
import { readSourceCount } from "@noelle/runtime/source-values";
import { defaultVideoApifyActor } from "../lib/apify-rotating.js";
import type { VideoClip } from "@noelle/video-apify";
import type { ActiveInstance } from "../lib/activation.js";
import type { ApifyHandle } from "../lib/apify-resolver.js";
import type { Logger } from "../lib/logger.js";
import {
  listEnabledSources,
  listEnabledNiches,
  markSourcePulled,
  markNichePulled,
} from "../lib/watchlist-db.js";
import { upsertVideoClips, flagDeepTier } from "../lib/video-clips-db.js";
import { selectCreatorWithReasons, selectNicheWithReasons } from "../lib/harvest-select.js";
import { gradeClipsForObjective, type JsonCaller } from "../lib/objective-grade.js";

/**
 * Live progress sink for one run. The harvester passes the worker_runs handle so
 * the tick can stream its summary after each lane and check for a Stop. Optional
 * — absent (e.g. in a unit test) the tick just runs to completion silently.
 */
export interface HarvestProgress {
  updateSummary(summary: HarvestRunSummary): Promise<void>;
  isCancelRequested(): Promise<boolean>;
}

function bestFollowerCount(clips: VideoClip[]): number | null {
  const counts = clips
    .map((c) => readSourceCount(c.authorFollowerCount))
    .filter((n): n is number => n !== null);
  return counts.length ? Math.max(...counts) : null;
}

export interface HarvesterTickDeps {
  sql: Sql;
  log: Logger;
  instance: ActiveInstance;
  resolveApify: (orgId: string) => Promise<ApifyHandle | null>;
  recorder: { record: (row: SpendRow) => Promise<unknown> };
  /**
   * Optional objective grader (Gemini JSON caller). When present AND the instance
   * has an objective, each niche lane's selected clips are filtered to the ones
   * on-objective before upsert — the Vega-style relevance pass. Absent / failing
   * = no grading (keep all). Creator lane is never graded (those are chosen feeds).
   */
  gradeJson?: JsonCaller;
  /** Live progress + cancellation sink (the worker_runs handle). */
  run?: HarvestProgress;
}

export class HarvestOutcomeError extends Error {
  constructor(cause: Error, readonly rowsProcessed: number) {
    super(cause.message, { cause });
    this.name = "HarvestOutcomeError";
  }
}

/**
 * One harvest run for an instance (W1 Harvest). Pulls each enabled creator +
 * niche via Apify, applies the W1 filters (top-by-views ∪ outperformers ∪
 * top-by-engagement / niche min-views+top-N), upserts into video_clips, meters
 * Apify spend, and flags the deep tier. Ordinary lane errors are recorded and
 * continue. Denied model admission stops later paid lanes with the count of
 * clips already upserted.
 */
export async function runHarvesterTick(deps: HarvesterTickDeps): Promise<number> {
  const { sql, log, instance, resolveApify, recorder, gradeJson, run } = deps;
  const objective = instance.objective?.trim() ?? "";
  const cfg = VideoFeederConfigSchema.parse((instance.video_feeder_config ?? {}) as object);
  const orgId = instance.org_id;
  let total = 0;

  // Live, inspectable run record — streamed after each lane so the console can
  // watch progress fill in and see *why* clips were dropped, not just a count.
  const startedIso = new Date().toISOString();
  const summary: HarvestRunSummary = {
    phase: "starting",
    lanes: [],
    totals: { pulled: 0, kept: 0 },
    config: {
      nicheMinViews: cfg.nicheTrending.minViews,
      nicheRecencyHours: cfg.nicheTrending.recencyWindowHours,
      creatorRecencyDays: cfg.recencyWindowDays,
    },
    startedAt: startedIso,
    updatedAt: startedIso,
  };
  const flush = async (phase: HarvestPhase): Promise<void> => {
    summary.phase = phase;
    summary.updatedAt = new Date().toISOString();
    await run?.updateSummary(summary);
  };
  const pushLane = async (lane: HarvestLaneResult): Promise<void> => {
    summary.lanes.push(lane);
    summary.totals.pulled += lane.pulled;
    summary.totals.kept += lane.kept;
    await flush(summary.phase);
  };
  const stopAdmission = async (error: Error): Promise<never> => {
    summary.error = error.message;
    await flush("error");
    throw new HarvestOutcomeError(error, total);
  };
  // The operator hit Stop → record it and let the caller finish the run cleanly.
  const cancelled = async (): Promise<boolean> => {
    if (!(await run?.isCancelRequested())) return false;
    log.info({ instance: instance.id }, "harvest cancelled by operator");
    await flush("cancelled");
    return true;
  };

  const handle = await resolveApify(instance.org_id);
  if (!handle) {
    log.warn({ instance: instance.id }, "no apify token; skipping harvest");
    summary.error = "No Apify token available — connect one to harvest.";
    await flush("error");
    return 0;
  }

  // --- creator lane ---
  await flush("creators");
  const sinceISO = new Date(Date.now() - cfg.recencyWindowDays * 86_400_000).toISOString();
  for (const s of await listEnabledSources(sql, instance.id)) {
    if (await cancelled()) return total;
    let pulledCount = 0;
    let selectedCount = 0;
    let writtenCount = 0;
    let notSelected = 0;
    try {
      // Follower count: IG's posts endpoint omits it, so fetch the profile snapshot
      // (cheap details call) to enable the outperformer lane (views ÷ followers).
      const snap = await withMeteredApifyCall({ client: handle.client, recorder, log,
        orgId, instanceId: instance.id, agentRole: "video_intern", worker: "harvester",
        actor: defaultVideoApifyActor(s.platform), startedAt: new Date(), credentialId: handle.credentialId },
        operation => operation.accountSnapshot({ platform: s.platform, handle: s.handle })).catch(() => null);
      const followerCount = readSourceCount(snap?.followerCount);
      const pulled = await withMeteredApifyCall({ client: handle.client, recorder, log,
        orgId, instanceId: instance.id, agentRole: "video_intern", worker: "harvester",
        actor: defaultVideoApifyActor(s.platform), startedAt: new Date(), credentialId: handle.credentialId },
        operation => operation.creatorReels({ platform: s.platform, handle: s.handle,
          maxItems: cfg.maxPerSource, sinceISO }));
      // Stamp the creator's follower count onto every clip so the outperformer lane
      // (views ÷ followers) + the ultra-profile have it (posts endpoint omits it).
      const clips =
        followerCount != null
          ? pulled.map((c) => ({ ...c, authorFollowerCount: followerCount }))
          : pulled;
      const { selected, dropped } = selectCreatorWithReasons(clips, cfg);
      pulledCount = pulled.length;
      selectedCount = selected.length;
      notSelected = dropped.notSelected;
      const written = await upsertVideoClips(sql, {
        orgId,
        instanceId: instance.id,
        sourceKind: "creator",
        clips: selected,
      });
      total += written;
      writtenCount = written;
      await markSourcePulled(sql, s.id, followerCount ?? bestFollowerCount(clips));
      await pushLane({
        kind: "creator",
        label: `@${s.handle}`,
        pulled: pulled.length,
        selected: selected.length,
        kept: written,
        dropped: { belowMinViews: 0, notSelected: dropped.notSelected, offObjective: 0 },
        graded: false,
      });
      log.info(
        { instance: instance.id, handle: s.handle, followers: followerCount, pulled: pulled.length, kept: written },
        "creator harvested",
      );
    } catch (err) {
      // One creator's pull failing (apify abort/quota/timeout) no longer kills the
      // whole run — record it on the lane and move to the next source.
      const message = (err as Error).message;
      const blocked = isBudgetAdmissionError(err);
      await pushLane({
        kind: "creator",
        label: `@${s.handle}`,
        pulled: blocked ? pulledCount : 0,
        selected: blocked ? selectedCount : 0,
        kept: blocked ? writtenCount : 0,
        dropped: { belowMinViews: 0, notSelected: blocked ? notSelected : 0, offObjective: 0 },
        graded: false,
        error: message.slice(0, 500),
      });
      log.error({ instance: instance.id, handle: s.handle, err: message }, "creator lane failed");
      if (blocked) await stopAdmission(err);
    }
  }

  // --- niche lane ---
  await flush("niches");
  const nicheSince = new Date(Date.now() - cfg.nicheTrending.recencyWindowHours * 3_600_000).toISOString();
  for (const nq of await listEnabledNiches(sql, instance.id)) {
    if (await cancelled()) return total;
    let pulledCount = 0;
    let selectedCount = 0;
    let writtenCount = 0;
    let drops = { belowMinViews: 0, notSelected: 0 };
    try {
      // Niche discovery may run several paid actors; meter every receipt.
      const clips = await withMeteredApifyCall({ client: handle.client, recorder, log,
        orgId, instanceId: instance.id, agentRole: "video_intern", worker: "harvester",
        actor: defaultVideoApifyActor(nq.platform), startedAt: new Date(), credentialId: handle.credentialId },
        operation => operation.nicheCreatorReels({ platform: nq.platform, query: nq.query,
          maxItems: Math.max(cfg.nicheTrending.n * 3, cfg.maxPerSource), sinceISO: nicheSince }));
      const { selected, dropped } = selectNicheWithReasons(clips, cfg);
      pulledCount = clips.length;
      selectedCount = selected.length;
      drops = dropped;
      // Objective grading (Vega-style): drop clips that don't serve the objective,
      // even if they trended. Fail-open — no grader / no objective / a flaky call
      // keeps `selected` unchanged. Grades the small selected set, not the raw pull.
      const graded = Boolean(gradeJson && objective);
      const onObjective =
        gradeJson && objective ? await gradeClipsForObjective(objective, selected, gradeJson) : selected;
      const written = await upsertVideoClips(sql, {
        orgId,
        instanceId: instance.id,
        sourceKind: "niche",
        clips: onObjective,
      });
      total += written;
      writtenCount = written;
      await markNichePulled(sql, nq.id);
      await pushLane({
        kind: "niche",
        label: nq.query,
        pulled: clips.length,
        selected: selected.length,
        kept: written,
        dropped: {
          belowMinViews: dropped.belowMinViews,
          notSelected: dropped.notSelected,
          offObjective: selected.length - onObjective.length,
        },
        graded,
      });
      log.info(
        {
          instance: instance.id,
          niche: nq.query,
          pulled: clips.length,
          selected: selected.length,
          kept: written,
          graded,
        },
        "niche harvested",
      );
    } catch (err) {
      const message = (err as Error).message;
      const blocked = isBudgetAdmissionError(err);
      await pushLane({
        kind: "niche",
        label: nq.query,
        pulled: blocked ? pulledCount : 0,
        selected: blocked ? selectedCount : 0,
        kept: blocked ? writtenCount : 0,
        dropped: { ...(blocked ? drops : { belowMinViews: 0, notSelected: 0 }), offObjective: 0 },
        graded: false,
        error: message.slice(0, 500),
      });
      log.error({ instance: instance.id, niche: nq.query, err: message }, "niche lane failed");
      if (blocked) await stopAdmission(err);
    }
  }

  await flagDeepTier(sql, instance.id, cfg.deepTierPercentile).catch(() => {});
  await flush("done");
  return total;
}

import {
  VideoFeederConfigSchema,
  type VideoFeederConfig,
  HarvestRunSummarySchema,
  type HarvestRunSummary,
} from "@noelle/contracts";
import { readSql as sql } from "@/lib/db";
import { getAgentInstance } from "@/lib/queries";
import { readSourceCount, readSourceNonnegativeNumber, readSourceTimestamp } from "@noelle/runtime/source-values";

// Read models for Nova (video_intern). Every read fetches the instance first via
// getAgentInstance (which runs assertOrgMember on the row's real org_id — the
// IDOR guard), then scopes by `and org_id = ${inst.org_id}`. bigint count
// columns come back as strings; decode measured values through the shared source owner.

export interface VideoSourceRow {
  id: string;
  platform: string;
  handle: string;
  display_name: string | null;
  note: string | null;
  enabled: boolean;
  follower_count: number | null;
  last_pulled_at: string | null;
}

export interface VideoNicheRow {
  id: string;
  platform: string;
  query: string;
  note: string | null;
  enabled: boolean;
  last_pulled_at: string | null;
}

export async function listVideoWatchlistSources(instanceId: string): Promise<VideoSourceRow[]> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return [];
  const rows = await sql<Array<Omit<VideoSourceRow, "follower_count"> & { follower_count: string | null }>>`
    select id, platform, handle, display_name, note, enabled,
           follower_count::text as follower_count,
           last_pulled_at::text as last_pulled_at
    from noelle.video_watchlist_sources
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
    order by created_at asc
  `;
  return rows.map((r) => ({
    ...r,
    follower_count: readSourceCount(r.follower_count),
  }));
}

export async function listVideoWatchlistNiches(instanceId: string): Promise<VideoNicheRow[]> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return [];
  const rows = await sql<VideoNicheRow[]>`
    select id, platform, query, note, enabled, last_pulled_at::text as last_pulled_at
    from noelle.video_watchlist_niches
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
    order by created_at asc
  `;
  return [...rows];
}

export async function countVideoWatchlistSources(instanceId: string): Promise<number> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return 0;
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from noelle.video_watchlist_sources
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
  `;
  return rows[0]?.n ?? 0;
}

export async function countVideoWatchlistNiches(instanceId: string): Promise<number> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return 0;
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from noelle.video_watchlist_niches
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
  `;
  return rows[0]?.n ?? 0;
}

// --- Harvest run status (clone of feeder-queries getFeederRunStatus) ---
export type HarvestRunState = "running" | "requested" | "stalled" | "errored" | "idle";
export interface HarvestRunStatus {
  state: HarvestRunState;
  lastRunAt: string | null;
  runRequestedAt: string | null;
  lastError: string | null;
  /** The latest run's id — the target for a Stop (cancel) request. */
  runId: string | null;
  /** Per-lane outcome of the latest run (live while running); null on legacy rows. */
  summary: HarvestRunSummary | null;
}
/**
 * How long the harvest run's summary heartbeat (updatedAt, bumped after every
 * lane) may go silent before we call the run stalled. A single niche lane on a
 * throttled Apify token can take ~5 min, so this must comfortably exceed one
 * lane's wall-clock — 12 min means "no lane finished for 12 min → genuinely stuck".
 */
const HARVEST_HEARTBEAT_STALE_MS = 12 * 60 * 1000;
/** Worker name the Scout harvester writes to noelle.worker_runs. */
export const HARVEST_WORKER = "harvester" as const;

export async function getVideoHarvestStatus(
  instanceId: string,
  nowMs: number = Date.now(),
): Promise<HarvestRunStatus | null> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return null;

  const instRows = await sql<Array<{ run_requested_at: string | null; last_run_at: string | null }>>`
    select video_feeder_run_requested_at::text as run_requested_at,
           video_feeder_last_run_at::text      as last_run_at
    from noelle.agent_instances
    where id = ${inst.id} and org_id = ${inst.org_id}
    limit 1
  `;
  const runRequestedAt = instRows[0]?.run_requested_at ?? null;
  const lastRunAt = instRows[0]?.last_run_at ?? null;

  // Instance-scoped since migration 0078 (worker_runs.instance_id). Legacy rows
  // (null instance_id) predate the console and are simply not shown.
  const runRows = await sql<
    Array<{ id: string; started_at: string | null; finished_at: string | null; error: string | null; summary: unknown }>
  >`
    select id, started_at::text as started_at, finished_at::text as finished_at, error, summary
    from noelle.worker_runs
    where worker = ${HARVEST_WORKER} and instance_id = ${inst.id}
    order by started_at desc nulls last
    limit 1
  `;
  const run = runRows[0];
  const lastError = run?.error ?? null;
  const parsed = run?.summary ? HarvestRunSummarySchema.safeParse(run.summary) : null;
  const summary = parsed?.success ? parsed.data : null;

  let state: HarvestRunState = "idle";
  if (run && run.started_at && run.finished_at == null) {
    // A run with an exhausted/throttled Apify pool can take an hour (each niche
    // is a slow actor run), so "started > 15 min ago" is NOT stalled. The tick
    // streams summary.updatedAt after every lane — treat THAT heartbeat as
    // liveness: fresh heartbeat = still working, only a truly silent run is
    // stalled. Falls back to started_at for legacy/empty summaries.
    const beatIso = summary?.updatedAt ?? run.started_at;
    const heartbeatMs = new Date(beatIso).getTime();
    state = nowMs - heartbeatMs < HARVEST_HEARTBEAT_STALE_MS ? "running" : "stalled";
  } else if (runRequestedAt && (lastRunAt == null || new Date(runRequestedAt) > new Date(lastRunAt))) {
    state = "requested";
  } else if (lastError) {
    state = "errored";
  }
  return { state, lastRunAt, runRequestedAt, lastError, runId: run?.id ?? null, summary };
}

/**
 * Read + normalise an instance's harvest filter config. Always returns a fully
 * defaulted VideoFeederConfig (the schema fills every knob), so the watchlist
 * filter form binds to concrete values even before the operator saves once —
 * exactly what the Scout harvester parses out of `video_feeder_config`.
 */
export async function getVideoFeederConfig(instanceId: string): Promise<VideoFeederConfig> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return VideoFeederConfigSchema.parse({});
  const rows = await sql<Array<{ cfg: unknown }>>`
    select video_feeder_config as cfg
    from noelle.agent_instances
    where id = ${inst.id} and org_id = ${inst.org_id}
    limit 1
  `;
  const parsed = VideoFeederConfigSchema.safeParse((rows[0]?.cfg ?? {}) as object);
  return parsed.success ? parsed.data : VideoFeederConfigSchema.parse({});
}

// --- Discover / Library: harvested clips ---
export interface VideoClipRow {
  id: string;
  platform: string;
  external_id: string;
  source_kind: string;
  author_handle: string;
  caption: string;
  url: string;
  thumb_url: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  author_follower_count: number | null;
  deep_tier: boolean;
  posted_at: string | null;
}

export async function listVideoClips(
  instanceId: string,
  opts: { sourceKind?: string | null; limit?: number } = {},
): Promise<VideoClipRow[]> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return [];

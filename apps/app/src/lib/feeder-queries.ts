import { cache } from "react";
import { approvalMemoryJoins } from "@noelle/runtime";
import { corpusEngagementSql } from "@noelle/runtime/account-feeder-db";
import { readSourceCount, readSourceTimestamp } from "@noelle/runtime/source-values";
import { readSql as sql, sql as fragmentSql } from "@/lib/db";
import { getAgentInstance } from "@/lib/queries";
import { normalizeLinkedinHandle } from "@/lib/utils";

// Read helpers for the Account Feeder (the "style sources" surface).
//
// The feeder learns a writing style from admired source accounts: it pulls
// their posts + authored comments, distils each into an "ultra profile", and
// builds a corpus the drafter samples per-lead. This module backs the dashboard
// subpage (the source list + the cost-gated Run card). The actual pull is done
// by the F5 worker; here we only read the curated source list and the run state.
//
// Tenancy: Cloud SQL has no RLS. Every read here goes through getAgentInstance,
// which runs assertOrgMember on the row's real org_id (the cross-tenant IDOR
// guard) before any feeder query, and every SQL statement also matches org_id in
// its WHERE clause. Run status additionally matches the heartbeat instance
// against its current parent organization after the membership check.

/** One curated source account (a noelle.account_feeder_sources row). */
export interface FeederSourceRow {
  id: string;
  platform: string;
  handle: string;
  display_name: string | null;
  note: string | null;
  enabled: boolean;
  last_pulled_at: string | null;
  created_at: string;
  /** Contact (noelle.persons) this source resolves to, for a deep link. */
  contact_person_id: string | null;
}

/**
 * Every curated source account for an instance, for the dashboard editor.
 * Oldest-first (stable add order). Tenancy: getAgentInstance asserts membership
 * on the instance's real org_id, and the org_id match in the WHERE clause is the
 * IDOR guard.
 */
export async function listFeederSources(
  instanceId: string,
): Promise<FeederSourceRow[]> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return [];
  const rows = await sql<FeederSourceRow[]>`
    select
      s.id, s.platform, s.handle, s.display_name, s.note, s.enabled,
      s.last_pulled_at::text as last_pulled_at,
      s.created_at::text as created_at,
      contact.person_id as contact_person_id
    from noelle.account_feeder_sources s
    left join lateral (
      select psa.person_id from noelle.person_social_accounts psa
      where psa.org_id = s.org_id and psa.platform = s.platform
        and regexp_replace(lower(psa.handle), '-[0-9a-f]{6,}$', '')
            = regexp_replace(lower(s.handle), '-[0-9a-f]{6,}$', '')
      limit 1
    ) contact on true
    where s.agent_instance_id = ${inst.id} and s.org_id = ${inst.org_id}
    order by s.created_at asc
  `;
  return [...rows];
}

/** Count of curated source accounts (drives the "Style sources" entry card). */
export async function countFeederSources(instanceId: string): Promise<number> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return 0;
  // count(*) is bigint → postgres.js returns it as a JS string. Cast to int in
  // SQL so the value arrives as a number and never gets string-concatenated.
  const rows = await sql<Array<{ n: number }>>`
    select count(*)::int as n
    from noelle.account_feeder_sources
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
  `;
  return rows[0]?.n ?? 0;
}

/** Collapsed run state for the feeder, shown on the Run card. */
export type FeederRunState = "running" | "requested" | "stalled" | "errored" | "idle";

export interface FeederRunStatus {
  /** Collapsed status word for the Run card's dot. */
  state: FeederRunState;
  /** account_feeder_last_run_at — when the worker last finished a pull. */
  lastRunAt: string | null;
  /** account_feeder_run_requested_at — set by the Run button, cleared by the worker. */
  runRequestedAt: string | null;
  /** Latest worker_runs row's started_at (worker='linkedin_feeder'). */
  lastStartedAt: string | null;
  /** Latest worker_runs row's finished_at. */
  lastFinishedAt: string | null;
  /** Latest worker_runs row's error, if the last run failed. */
  lastError: string | null;
}

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

/**
 * Worker name written to noelle.worker_runs by the F5 account-feeder worker.
 * Kept in sync with the feeder's heartbeat writes (spec §7 F5 / §2.18).
 */
export const FEEDER_WORKER = "linkedin_feeder" as const;

/**
 * Run state for the feeder, for the dashboard Run card. Folds three signals:
 *  - the instance's request/last-run timestamps (the flag the Run button flips
 *    + the stamp the worker writes when it finishes), and
 *  - the latest noelle.worker_runs heartbeat for worker='linkedin_feeder'.
 *
 * State precedence (mirrors deriveVegaWorkerStatus, plus a "requested" pre-run
 * state unique to the cost-gated manual trigger):
 *   - "running"   — a worker_runs row is open (finished_at NULL) < 15 min old.
 *   - "stalled"   — a worker_runs row is open but older than 15 min (died mid-tick).
 *   - "requested" — the Run flag is set and newer than the last finished run, but
 *                   no live heartbeat yet (the worker hasn't picked it up). The
 *                   button disables in this state so we never double-request.
 *   - "errored"   — the most recent finished worker_runs row carries an error.
 *   - "idle"      — everything else.
 *
 * Until the F5 worker is deployed nothing writes worker_runs for the feeder, so
 * after a click this correctly reads "requested" (the flag is set, no heartbeat),
 * which is exactly the state we want to surface pre-worker.
 *
 * Tenancy: the instance read is membership-guarded via getAgentInstance;
 * the heartbeat is bound to this instance and its current organization.
 */
export async function getFeederRunStatus(
  instanceId: string,
  nowMs: number = Date.now(),
): Promise<FeederRunStatus | null> {
  const inst = await getAgentInstance(instanceId);
  if (!inst) return null;

  const instRows = await sql<
    Array<{ run_requested_at: string | null; last_run_at: string | null }>
  >`
    select
      account_feeder_run_requested_at::text as run_requested_at,
      account_feeder_last_run_at::text      as last_run_at
    from noelle.agent_instances
    where id = ${inst.id} and org_id = ${inst.org_id}
    limit 1
  `;
  const runRequestedAt = instRows[0]?.run_requested_at ?? null;
  const lastRunAt = instRows[0]?.last_run_at ?? null;

  // Latest heartbeat for this feeder instance under its current organization.
  const runRows = await sql<
    Array<{
      started_at: string | null;
      finished_at: string | null;
      error: string | null;
    }>
  >`
    select
      r.started_at::text  as started_at,
      r.finished_at::text as finished_at,
      r.error
    from noelle.worker_runs r
    join noelle.agent_instances ai on ai.id = r.instance_id and ai.org_id = ${inst.org_id}
    where r.worker = ${FEEDER_WORKER} and r.instance_id = ${inst.id}
    order by r.started_at desc nulls last
    limit 1
  `;
  const run = runRows[0];
  const lastStartedAt = run?.started_at ?? null;
  const lastFinishedAt = run?.finished_at ?? null;
  const lastError = run?.error ?? null;

  let state: FeederRunState = "idle";
  if (run && run.started_at && run.finished_at == null) {
    const ageMs = nowMs - new Date(run.started_at).getTime();
    state = ageMs < FIFTEEN_MIN_MS ? "running" : "stalled";
  } else if (
    runRequestedAt &&
    (lastRunAt == null || new Date(runRequestedAt) > new Date(lastRunAt))
  ) {
    // Flag set + the worker hasn't recorded a finish for it yet.
    state = "requested";
  } else if (lastError) {
    state = "errored";
  }

  return {
    state,
    lastRunAt,
    runRequestedAt,
    lastStartedAt,
    lastFinishedAt,
    lastError,
  };
}

/** The extracted Gemini "ultra profile" for a style source, as the UI renders it. */
export interface UltraProfileView {
  voiceSummary: string | null;

import type { Sql } from "postgres";
import { recordRun, type RunHandle } from "@noelle/runtime/worker-runs";
import type { ActiveInstance } from "./activation.js";
// Shared style-corpus types remain available through this facade.
export type { StyleExemplarRow, UltraProfileRow } from "@noelle/runtime";
export { upsertStylePosts, listUnembeddedStylePosts, updateStylePostEmbeddings, getAccountCorpus, listStyleExemplars, listStyleExemplarsForHandle, parsePgVector, upsertAccountUltraProfile, listEnabledFeederSources, listFeederSources, listUltraProfiles, getUltraProfileForHandle } from "@noelle/runtime/account-feeder-db";
export type { StylePostUpsert, StylePostEmbedding, UnembeddedStylePost, CorpusItem, AccountUltraProfileUpsert, FeederSource } from "@noelle/runtime/account-feeder-db";

// Direct-SQL queries for the Account Feeder (0051_account_feeder.sql). Mirrors
// lib/watchlist-db.ts (the profiler precedent): the feeder writes the style
// corpus + ultra profiles straight to Cloud SQL via the noelle_app role — there
// is no api-vm ingest route for it.
//
//   - noelle.account_feeder_sources   (A) — the curated source accounts
//   - noelle.account_style_posts      (B) — the style corpus (posts + comments)
//   - noelle.account_ultra_profiles   (C) — one extracted "ultra profile" / account
//
// Run tracking lives on agent_instances: account_feeder_run_requested_at (set by
// the dashboard Run card) + account_feeder_last_run_at (stamped here when a run
// completes). last_run >= requested means "no pending run".

/**
 * Instances with a PENDING manual feeder run. NOT the normal active/paused gate:
 * a feeder run is manual and must execute even while the instance is paused, so
 * this selects purely on the run flags — requested AND (never run OR requested
 * after the last run). Returns the full worker-facing row (org_id + the feeder
 * config) so the tick can read account_feeder_config without a second query.
 */
export async function listInstancesWithPendingFeederRun(
  sql: Sql,
): Promise<FeederInstance[]> {
  const rows = await sql<FeederInstance[]>`
    select
      id,
      org_id,
      status,
      objective,
      account_feeder_config,
      account_feeder_run_requested_at,
      account_feeder_last_run_at
    from noelle.agent_instances
    where role = 'linkedin_intern'
      and account_feeder_run_requested_at is not null
      and (
        account_feeder_last_run_at is null
        or account_feeder_run_requested_at > account_feeder_last_run_at
      )
    order by account_feeder_run_requested_at asc
  `;
  return [...rows];
}

/** A worker-facing instance row for the feeder (subset of agent_instances). */
export interface FeederInstance extends Pick<ActiveInstance, "id" | "org_id" | "status" | "objective"> {
  account_feeder_config?: unknown;
  account_feeder_run_requested_at?: string | null;
  account_feeder_last_run_at?: string | null;
}

/** Stamp last_pulled_at on a source after its Apify pull completes. */
export async function markSourcePulled(sql: Sql, sourceId: string): Promise<void> {
  await sql`
    update noelle.account_feeder_sources
    set last_pulled_at = now()
    where id = ${sourceId}
  `;
}

/**
 * Stamp account_feeder_last_run_at = now() on the instance. Because the pending
 * selector is "requested > last_run", stamping last_run to now() (which is >=
 * the requested time that triggered this run) CLEARS the pending flag — the same
 * "flag flip the worker advances" pattern the rest of the pipeline uses. Always
 * called in a finally so a crashed run never strands the instance in "pending".
 */
export async function markFeederRunComplete(sql: Sql, instanceId: string): Promise<void> {
  await sql`
    update noelle.agent_instances
    set account_feeder_last_run_at = now()
    where id = ${instanceId}
  `;
}

export type FeederRunHandle = Pick<RunHandle, "id" | "finish">;

/** Record this manual feeder run against its owning instance. */
export function recordFeederRun(sql: Sql, instanceId: string): Promise<FeederRunHandle> {
  return recordRun({ sql, kind: "linkedin_feeder", instanceId });
}

import type { Sql } from "postgres";
import type { Logger } from "../lib/logger.js";
import type { ActiveInstance } from "../lib/activation.js";
import type { CodexRunner } from "../lib/codex-runner.js";
import { xInternRouting } from "../lib/routing.js";
import { getWatchlistAuthorEngagement } from "../lib/leads-engagement-db.js";
import {
  computePercentiles,
  buildAnalystSystem,
  renderAnalystPrompt,
  PlaybookOutputSchema,
  safeJsonParse,
} from "../lib/engagement-analyst.js";
import { upsertPlaybook, getFreshPlaybookAuthors } from "@noelle/runtime/playbooks-db";

// ENGAGEMENT ANALYST tick (Vega). Ported from Lyra.
//
// Reads the engagement already captured on watchlist people's posts — no extra
// Apify spend, the counts are already on the leads — ranks the top performers,
// and asks the model to describe patterns in a bounded measured sample. The
// result is a per-author "playbook" (hook patterns, structure, recurring topics) that the
// ideation lane and the drafter can borrow the SHAPE from.
//
// Cost shape: one cheap LLM call per author needing a refresh, capped per tick
// and skipped entirely for authors whose playbook is still fresh. Zero Apify.

export interface RunAnalystTickArgs {
  sql: Sql;
  log: Logger;
  instance: ActiveInstance;
  runner: CodexRunner;
  /** How far back to read engagement. */
  windowDays: number;
  /** Max authors to rank; the tick refreshes at most `maxPerTick` of them. */
  limitAuthors: number;
  maxPerTick: number;
  /** Best posts per author handed to the analyst. */
  samplePosts: number;
  /** Authors with fewer posts than this in the window are skipped (noise). */
  minPosts: number;
  /** A playbook younger than this is left alone. */
  staleDays: number;
}

export interface AnalystTickResult {
  ranked: number;
  refreshed: number;
  skippedFresh: number;
}

export async function runAnalystTick(args: RunAnalystTickArgs): Promise<AnalystTickResult> {
  const { sql, log, instance, runner } = args;

  const ranked = await getWatchlistAuthorEngagement(sql, {
    agentInstanceId: instance.id,
    windowDays: args.windowDays,
    limitAuthors: args.limitAuthors,
    samplePosts: args.samplePosts,
    minPosts: args.minPosts,
  });
  if (ranked.length === 0) return { ranked: 0, refreshed: 0, skippedFresh: 0 };

  // Percentiles come from the FULL ranking, before any freshness filtering, so a
  // person's percentile is within the bounded, measured author cohort and does
  // not drift just because their neighbours happened to be refreshed already.
  const percentiles = computePercentiles(ranked);

  const fresh = await getFreshPlaybookAuthors(sql, {
    orgId: instance.org_id,
    agentInstanceId: instance.id,
    platform: "x",
    authorHandles: ranked.map((a) => a.authorHandle),
    staleDays: args.staleDays,
  }).catch(() => new Set<string>());

  const due = ranked.filter((a) => !fresh.has(a.authorHandle)).slice(0, args.maxPerTick);
  let refreshed = 0;

  for (const author of due) {
    try {
      const res = await runner.draft({
        bucket: "analyst",
        routing: xInternRouting(instance),
        orgId: instance.org_id,
        instanceId: instance.id,
        worker: "profiler",
        agentRole: "x_intern",
        system: buildAnalystSystem(),
        prompt: renderAnalystPrompt(author),
      });
      const parsed = PlaybookOutputSchema.safeParse(safeJsonParse(res.text));
      if (!parsed.success) {
        log.warn(
          { instance: instance.id, author: author.authorHandle },
          "analyst: unparseable playbook; skipping this author",
        );
        continue;
      }
      await upsertPlaybook(sql, {
        orgId: instance.org_id,
        agentInstanceId: instance.id,
        platform: "x",
        authorHandle: author.authorHandle,
        // LinkedIn-shaped column; X has no fsd profile id.
        fsdProfileId: null,
        hookPatterns: parsed.data.hook_patterns,
        structureNotes: parsed.data.structure_notes,
        cadenceNotes: parsed.data.cadence_notes,
        topTopics: parsed.data.top_topics,
        engagementPercentile: percentiles.get(author.authorHandle) ?? 0,
        samplePostIds: author.samplePosts.map((p) => p.externalId),
        model: res.model,
      });
      refreshed++;
    } catch (err) {
      // One author failing must not abandon the rest of the batch.
      log.warn(
        { instance: instance.id, author: author.authorHandle, err: (err as Error).message },
        "analyst: playbook refresh failed (ignored)",
      );
    }
  }

  log.info(
    { instance: instance.id, ranked: ranked.length, refreshed, skippedFresh: fresh.size },
    "engagement analyst tick complete",
  );
  return { ranked: ranked.length, refreshed, skippedFresh: fresh.size };
}

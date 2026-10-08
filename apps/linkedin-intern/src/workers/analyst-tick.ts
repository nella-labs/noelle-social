import type { Logger } from "../lib/logger.js";
import type { ActiveInstance } from "../lib/activation.js";
import type { CodexRunner } from "../lib/codex-runner.js";
import type { PlaybookUpsert } from "../lib/playbooks-db.js";
import { linkedinInternRouting } from "../lib/routing.js";
import {
  type AuthorEngagement,
  PlaybookOutputSchema,
  buildAnalystSystem,
  computePercentiles,
  renderAnalystPrompt,
  safeJsonParse,
} from "../lib/engagement-analyst.js";

export interface RunAnalystTickArgs {
  log: Logger;
  instance: ActiveInstance;
  /** Top watchlist authors ranked best-first (getWatchlistAuthorEngagement). */
  ranked: AuthorEngagement[];
  /** Author handles whose playbook is fresh — skip them (complement = refresh). */
  freshHandles: Set<string>;
  /** Max authors to (re)analyze this tick (one LLM call each). */
  batch: number;
  runner: Pick<CodexRunner, "draft">;
  upsertPlaybook: (p: PlaybookUpsert) => Promise<void>;
}

/**
 * Engagement Analyst pass. Computes each top author's engagement percentile from
 * the full ranked list, then distills a playbook for up to `batch` authors that
 * lack a fresh one — cheapest-first by leaving fresh authors untouched. One LLM
 * call per author (bucket 'ideation' — this is cheap analysis, not the post
 * write). Returns how many playbooks were written.
 */
export async function runAnalystTick(args: RunAnalystTickArgs): Promise<number> {
  const { log, instance, ranked, freshHandles, batch, runner, upsertPlaybook } = args;
  const percentiles = computePercentiles(ranked);

  const stale = ranked.filter((a) => !freshHandles.has(a.authorHandle)).slice(0, batch);
  if (stale.length === 0) return 0;

  let written = 0;
  for (const author of stale) {
    try {
      const res = await runner.draft({
        bucket: "ideation",
        routing: linkedinInternRouting(instance),
        orgId: instance.org_id,
        instanceId: instance.id,
        worker: "analyst",
        agentRole: "linkedin_intern",
        system: buildAnalystSystem(),
        prompt: renderAnalystPrompt(author),
      });
      const parsed = PlaybookOutputSchema.safeParse(safeJsonParse(res.text));
      if (!parsed.success) {
        log.warn(
          { author: author.authorHandle, raw: res.text.slice(0, 160) },
          "analyst output schema fail; skipping author",
        );
        continue;
      }
      await upsertPlaybook({
        orgId: instance.org_id,
        agentInstanceId: instance.id,
        platform: "linkedin",
        authorHandle: author.authorHandle,
        fsdProfileId: author.authorId,
        hookPatterns: parsed.data.hook_patterns,
        structureNotes: parsed.data.structure_notes,
        cadenceNotes: parsed.data.cadence_notes,
        topTopics: parsed.data.top_topics,
        engagementPercentile: percentiles.get(author.authorHandle) ?? 0,
        samplePostIds: author.samplePosts.map((p) => p.externalId).filter(Boolean),
        model: res.model,
      });
      written++;
    } catch (err) {
      log.error(
        { author: author.authorHandle, err: (err as Error).message },
        "analyst tick failed for author",
      );
    }
  }
  log.info({ written, candidates: stale.length }, "analyst tick complete");
  return written;
}

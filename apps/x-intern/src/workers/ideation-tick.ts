import type { Logger } from "../lib/logger.js";
import type { ActiveInstance } from "../lib/activation.js";
import type { CodexRunner } from "../lib/codex-runner.js";
import type { PostIdeaIn } from "@noelle/contracts";
import { parseBrandConfig, brandConfigHasContent } from "@noelle/contracts";
import { generateCheckedIdeas } from "@noelle/runtime";
import type { IdeationRequest } from "../lib/ideation-requests-db.js";
import { xInternRouting } from "../lib/routing.js";
import { renderBrandBlock } from "../lib/prompts.js";
import {
  type IdeationGather,
  IdeaSynthSchema,
  assembleIdeas,
  buildIdeationSystem,
  buildSources,
  renderIdeationPrompt,
  safeJsonParse,
} from "../lib/ideation.js";

const BATCH_IDEA_COUNT = 7; // a weekly batch is always Mon-Sun.

export interface RunIdeationTickArgs {
  log: Logger;
  instance: ActiveInstance;
  request: IdeationRequest;
  /** Reads the ideation sources (DB/Apify/KB). Injected for testability. */
  gather: (req: IdeationRequest) => Promise<IdeationGather>;
  runner: Pick<CodexRunner, "draft">;
  /** Pushes the assembled idea cards to the api-vm (HMAC /api/post-ideas). */
  sink: (ideas: PostIdeaIn[]) => Promise<{ idea_ids: string[] }>;
  /** Stable id per idea (crypto.randomUUID in prod; deterministic in tests). */
  idFactory: () => string;
  /** Default idea count for single mode when the request omits it. */
  defaultCount: number;
}

/**
 * Run one X ideation request: gather the sources, synthesize idea cards with the
 * cheap `ideation` model, resolve their inspiration refs, and push them to the
 * api-vm tagged platform="x". Returns how many ideas were created (0 on a parse
 * fail). Never auto-drafts — these are proposals the operator reviews + clicks
 * Generate on.
 */
export async function runIdeationTick(args: RunIdeationTickArgs): Promise<number> {
  const { log, instance, request, gather, runner, sink, idFactory } = args;
  const count = request.mode === "batch" ? BATCH_IDEA_COUNT : request.count ?? args.defaultCount;

  const gathered = await gather(request);
  // Guard: with no sources AND no voice anchors there's nothing to ground ideas
  // in — skip rather than hallucinate.
  if (
    (gathered.repliedPosts?.length ?? 0) === 0 &&
    gathered.topAuthors.length === 0 &&
    gathered.keywordPosts.length === 0 &&
    gathered.voiceAnchors.length === 0
  ) {
    log.warn({ instance: instance.id }, "x ideation: no sources gathered; skipping");
    return 0;
  }

  const { sources } = buildSources(gathered);
  // Same brand context the drafter writes with, so ideas are on-brand, not just
  // on-voice. Empty brand_config → fall back to voice/objective grounding.
  const brand = parseBrandConfig(instance.brand_config);
  const brandBlock = brandConfigHasContent(brand) ? renderBrandBlock(brand) : null;
  const prompt = renderIdeationPrompt(gathered, { count, topics: request.topics });
  const checked = await generateCheckedIdeas(
    (feedback) => runner.draft({
      bucket: "ideation",
      routing: xInternRouting(instance),
      orgId: instance.org_id,
      instanceId: instance.id,
      worker: "ideation",
      agentRole: "x_intern",
      system: buildIdeationSystem(instance.objective ?? null, brandBlock, gathered.ownPerformance),
      prompt: feedback ? `${prompt}\n\n${feedback}` : prompt,
    }),
    (text) => {
      const parsed = IdeaSynthSchema.safeParse(safeJsonParse(text));
      if (parsed.success) return parsed.data.ideas;
      log.error({ instance: instance.id, raw: text.slice(0, 200) }, "x ideation output schema fail");
      return null;
    },
  );
  if (!checked) return 0;

  const ideas = assembleIdeas({ ideas: checked.ideas }, sources, {
    idFactory,
    sourceEngine: checked.response.engine,
    model: checked.response.model,
    batchId: request.batchId,
    weekStart: request.mode === "batch" ? request.weekStart : null,
    // The lane scopes the fan-out; null ⇒ X-only (the X lane default).
    targetPlatforms: request.targetPlatforms,
  });
  if (ideas.length === 0) return 0;

  const created = await sink(ideas);
  log.info(
    { instance: instance.id, mode: request.mode, ideas: created.idea_ids.length },
    "x ideation tick complete",
  );
  return created.idea_ids.length;
}

import type { Logger } from "../lib/logger.js";
import type { ActiveInstance } from "../lib/activation.js";
import type { CodexRunner } from "../lib/codex-runner.js";
import { generateCheckedIdeas } from "@noelle/runtime";
import type { IdeationRequest } from "../lib/ideation-requests-db.js";
import { parseBrandConfig, brandConfigHasContent } from "@noelle/contracts";
import { linkedinInternRouting } from "../lib/routing.js";
import { renderBrandBlock } from "../lib/prompts.js";
import {
  type PolishIdeaInput,
  buildPolishSystem,
  renderPolishPrompt,
  parsePolish,
} from "../lib/idea-polish.js";

// Run one POLISH request (mode='polish'): load the target idea, refine its hook
// + thesis in the operator's voice, write it back. Mirrors runIdeationTick's
// shape — all I/O injected so the logic is testable without a DB or LLM.

export interface RunPolishTickArgs {
  log: Logger;
  instance: ActiveInstance;
  request: IdeationRequest;
  /** Load the target idea (null if it vanished / belongs to another instance). */
  loadIdea: (ideaId: string) => Promise<PolishIdeaInput | null>;
  /** Voice anchors for the idea (KB search). */
  voiceAnchors: (idea: PolishIdeaInput) => Promise<string[]>;
  runner: Pick<CodexRunner, "draft">;
  /** Persist the refined hook/thesis to noelle.post_ideas. */
  apply: (ideaId: string, result: { hook: string; thesis: string | null }) => Promise<void>;
}

/** Refine one idea in place. Returns 1 on success, 0 when skipped/soft-failed. */
export async function runPolishTick(args: RunPolishTickArgs): Promise<number> {
  const { log, instance, request, loadIdea, voiceAnchors, runner, apply } = args;
  if (!request.ideaId) {
    log.warn({ req: request.id }, "polish request has no idea_id; skipping");
    return 0;
  }
  const idea = await loadIdea(request.ideaId);
  if (!idea) {
    log.warn({ req: request.id, idea: request.ideaId }, "polish: idea not found; skipping");
    return 0;
  }

  const anchors = await voiceAnchors(idea).catch(() => []);
  const brand = parseBrandConfig(instance.brand_config);
  const brandBlock = brandConfigHasContent(brand) ? renderBrandBlock(brand) : null;

  const system = buildPolishSystem(instance.objective ?? null, brandBlock);
  const prompt = renderPolishPrompt(idea, anchors);
  const checked = await generateCheckedIdeas(
    (feedback) => runner.draft({
      bucket: "ideation",
      routing: linkedinInternRouting(instance),
      orgId: instance.org_id,
      instanceId: instance.id,
      worker: "ideation",
      agentRole: "linkedin_intern",
      system,
      prompt: feedback ? `${prompt}\n\n${feedback}` : prompt,
    }),
    (text) => {
      const parsed = parsePolish(text);
      return parsed ? [parsed] : null;
    },
  );
  if (!checked) {
    log.error({ idea: request.ideaId }, "polish output schema fail");
    return 0;
  }

  const parsed = checked.ideas[0]!;
  await apply(request.ideaId, { hook: parsed.hook, thesis: parsed.thesis });
  log.info({ instance: instance.id, idea: request.ideaId }, "polish tick complete");
  return 1;
}

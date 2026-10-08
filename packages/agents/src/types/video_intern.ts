import { z } from "zod";
import { defineAgent } from "../define.js";
import type { AgentType } from "../types.js";
import type { RuntimeServices } from "../services.js";
import { createContextSearchTool, getAgentAnchors } from "../context.js";

// Nova — the Instagram/TikTok short-form video intelligence agent. Sibling to
// Vega (X), Lyra (LinkedIn), Orion (Reddit). Draft-only: Nova studies the viral
// creators the operator watches, distils their video structure into a "Video
// Brand Guide", and helps plan + SCRIPT the next short-form video. It never
// posts to IG/TikTok — the operator records and posts by hand.
//
// Worker entrypoints own video research and script generation.

const VIDEO_INTERN_SYSTEM_PROMPT = [
  "You are Nova, a short-form video Growth Intern for Instagram and TikTok.",
  "You learn from the viral creators the operator watches — their hooks, structure,",
  "transitions, pacing, CTAs, and sounds — and help the operator plan and script",
  "their own videos in the operator's voice. Use the supplied voice anchors and the",
  "idea brief. Output a tight, timed short-form script: a scroll-stopping hook,",
  "ordered beats, and a clear CTA. You NEVER post to IG/TikTok — the operator records",
  "and posts every video by hand. Draft-only.",
].join(" ");

// A Nova "lead" is a video idea to script (not a thread to reply to). The full
// idea shape (inspiration clips, exemplars, brand guide) is gathered by the
// scripter; this is the minimal payload accepted by the registry entrypoint.
const IdeaSchema = z.object({
  id: z.string(),
  hook: z.string(),
  concept: z.string().optional(),
});

export type VideoIdeaLead = z.infer<typeof IdeaSchema>;

export function createVideoInternAgent(svc: RuntimeServices): AgentType {
  const tools = [createContextSearchTool(svc)];

  return defineAgent({
    id: "video_intern",
    defaultBucket: "drafter",
    defaultModel: {
      primary: { engine: "bedrock", model: "claude-sonnet-4-6" },
      fallback: { engine: "vertex", model: "claude-sonnet-4-6" },
    },
    tools,
    async run(ctx) {
      const idea = IdeaSchema.parse(ctx.payload);
      const anchors = await getAgentAnchors(svc, { orgId: ctx.orgId, query: idea.hook });
      const prompt = renderScriptPrompt(idea, anchors);
      const res = await svc.callAgentModel({
        bucket: ctx.bucket,
        routing: ctx.routing,
        orgId: ctx.orgId,
        instanceId: ctx.instanceId,
        worker: "drafter",
        agentRole: "video_intern",
        system: VIDEO_INTERN_SYSTEM_PROMPT,
        prompt,
        payload: ctx.payload,
      });
      ctx.log("video_intern drafted", {
        idea_id: idea.id,
        engine: res.engineUsed.engine,
        chars: res.text.length,
        anchors: anchors.length,
      });
    },
    async render(instance) {
      return {
        role: "video_intern" as const,
        instanceId: instance.id,
        status: instance.status,
        budgetCapCents: instance.budget_cap_cents,
      };
    },
  });
}

function renderScriptPrompt(
  idea: VideoIdeaLead,
  anchors: ReadonlyArray<{ snippet: string }>,
): string {
  const anchorBlock = anchors
    .slice(0, 8)
    .map((a, i) => `[anchor ${i + 1}] ${a.snippet}`)
    .join("\n");
  return [
    `Video idea to script:`,
    `Hook: ${idea.hook}`,
    idea.concept ? `Concept: ${idea.concept}` : "",
    "",
    "Voice anchors from the operator's vault:",
    anchorBlock || "(no anchors found — script from general voice)",
    "",
    "Return a short-form script as JSON: {hook: string, beats: string[], cta: string}.",
  ]
    .filter(Boolean)
    .join("\n");
}

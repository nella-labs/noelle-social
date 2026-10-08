import { z } from "zod";
import { defineAgent } from "../define.js";
import type { AgentType } from "../types.js";
import type { RuntimeServices } from "../services.js";
import { createContextSearchTool, getAgentAnchors } from "../context.js";

const REDDIT_INTERN_SYSTEM_PROMPT = [
  "You are a Reddit Growth Intern. You draft replies to in-ICP threads in the",
  "operator's watched subreddits — communities where the operator's audience asks",
  "questions and shares problems relevant to the configured goal.",
  "Use the supplied voice anchors and the thread context. Output exactly three reply",
  "angles: empathetic, technical, contrarian. You NEVER post to Reddit — the operator",
  "reviews and posts every reply by hand. Draft-only.",
].join(" ");

// Reddit leads have no velocity_score. `handle` is the subreddit (or thread author).
const LeadSchema = z.object({
  id: z.string(),
  post_text: z.string(),
  handle: z.string().optional(),
});

export type Lead = z.infer<typeof LeadSchema>;

export function createRedditInternAgent(svc: RuntimeServices): AgentType {
  const tools = [createContextSearchTool(svc)];

  return defineAgent({
    id: "reddit_intern",
    defaultBucket: "drafter",
    defaultModel: {
      primary: { engine: "vertex", model: "claude-sonnet-4-6" },
      fallback: { engine: "bedrock", model: "claude-sonnet-4-6" },
    },
    tools,
    async run(ctx) {
      const lead = LeadSchema.parse(ctx.payload);
      const anchors = await getAgentAnchors(svc, { orgId: ctx.orgId, query: lead.post_text });
      const prompt = renderDrafterPrompt(lead, anchors);
      const res = await svc.callAgentModel({
        bucket: ctx.bucket,
        routing: ctx.routing,
        orgId: ctx.orgId,
        instanceId: ctx.instanceId,
        worker: "drafter",
        agentRole: "reddit_intern",
        system: REDDIT_INTERN_SYSTEM_PROMPT,
        prompt,
        payload: ctx.payload,
      });
      ctx.log("reddit_intern drafted", {
        lead_id: lead.id,
        engine: res.engineUsed.engine,
        chars: res.text.length,
        anchors: anchors.length,
      });
    },
    async render(instance) {
      return {
        role: "reddit_intern" as const,
        instanceId: instance.id,
        status: instance.status,
        budgetCapCents: instance.budget_cap_cents,
      };
    },
  });
}

function renderDrafterPrompt(lead: Lead, anchors: ReadonlyArray<{ snippet: string }>): string {
  const anchorBlock = anchors
    .slice(0, 8)
    .map((a, i) => `[anchor ${i + 1}] ${a.snippet}`)
    .join("\n");
  return [
    `Reddit thread in ${lead.handle ?? "a watched subreddit"}:`,
    lead.post_text,
    "",
    "Voice anchors from the operator's vault:",
    anchorBlock || "(no anchors found — draft from general voice)",
    "",
    "Return three reply drafts as JSON array: [{angle: string, text: string}, ...].",
  ].join("\n");
}

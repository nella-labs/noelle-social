import { z } from "zod";
import { defineAgent } from "../define.js";
import type { AgentType } from "../types.js";
import type { RuntimeServices } from "../services.js";
import { createContextSearchTool, getAgentAnchors } from "../context.js";

const LINKEDIN_INTERN_SYSTEM_PROMPT = [
  "You are a LinkedIn Growth Intern. You draft replies (comments) and DMs to posts",
  "from the operator's watchlist of LinkedIn connections — mostly people and",
  "accounts relevant to the configured growth objective.",
  "Use the supplied voice anchors and the person's profile. Output exactly three reply",
  "angles: empathetic, technical, contrarian. You NEVER post — the operator sends every",
  "reply and DM by hand.",
].join(" ");

// LinkedIn leads have no velocity_score. `handle` is the person's public_id slug.
const LeadSchema = z.object({
  id: z.string(),
  post_text: z.string(),
  handle: z.string().optional(),
});

export type Lead = z.infer<typeof LeadSchema>;

export function createLinkedinInternAgent(svc: RuntimeServices): AgentType {
  const tools = [createContextSearchTool(svc)];

  return defineAgent({
    id: "linkedin_intern",
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
        agentRole: "linkedin_intern",
        system: LINKEDIN_INTERN_SYSTEM_PROMPT,
        prompt,
        payload: ctx.payload,
      });
      ctx.log("linkedin_intern drafted", {
        lead_id: lead.id,
        engine: res.engineUsed.engine,
        chars: res.text.length,
        anchors: anchors.length,
      });
    },
    async render(instance) {
      return {
        role: "linkedin_intern" as const,
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
    `LinkedIn post by ${lead.handle ?? "a watchlist connection"}:`,
    lead.post_text,
    "",
    "Voice anchors from the operator's vault:",
    anchorBlock || "(no anchors found — draft from general voice)",
    "",
    "Return three reply drafts as JSON array: [{angle: string, text: string}, ...].",
  ].join("\n");
}

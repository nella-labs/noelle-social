import { z } from "zod";
import { defineAgent } from "../define.js";
import type { AgentType } from "../types.js";
import type { RuntimeServices } from "../services.js";
import { createContextSearchTool, getAgentAnchors } from "../context.js";

const X_INTERN_SYSTEM_PROMPT = [
  "You are an X Growth Intern. You draft on-brand replies to monitored X posts.",
  "Use the supplied voice anchors. Output exactly three drafts: empathetic, technical, contrarian.",
].join(" ");

const LeadSchema = z.object({
  id: z.string(),
  post_text: z.string(),
  handle: z.string().optional(),
  velocity_score: z.number().optional(),
});

export type Lead = z.infer<typeof LeadSchema>;

export function createXInternAgent(svc: RuntimeServices): AgentType {
  const tools = [createContextSearchTool(svc)];

  return defineAgent({
    id: "x_intern",
    defaultBucket: "drafter",
    defaultModel: {
      primary: { engine: "bedrock", model: "claude-sonnet-4-6" },
      fallback: { engine: "vertex", model: "claude-sonnet-4-6" },
      escalation: {
        engine: { engine: "bedrock", model: "claude-opus-4-6" },
        when: (ctx) => {
          const parsed = z
            .object({ velocity_score: z.number().optional() })
            .safeParse(ctx.payload);
          if (!parsed.success) return false;
          return (parsed.data.velocity_score ?? 0) >= 80;
        },
      },
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
        agentRole: "x_intern",
        system: X_INTERN_SYSTEM_PROMPT,
        prompt,
        payload: ctx.payload,
      });
      ctx.log("x_intern drafted", {
        lead_id: lead.id,
        engine: res.engineUsed.engine,
        chars: res.text.length,
        anchors: anchors.length,
      });
    },
    async render(instance) {
      return {
        role: "x_intern" as const,
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
    `Lead post by @${lead.handle ?? "unknown"} (velocity_score=${lead.velocity_score ?? "n/a"}):`,
    lead.post_text,
    "",
    "Voice anchors from the operator's vault:",
    anchorBlock || "(no anchors found — draft from general voice)",
    "",
    "Return three drafts as JSON array: [{angle: string, text: string}, ...].",
  ].join("\n");
}

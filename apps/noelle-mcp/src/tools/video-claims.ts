import { z } from "zod";
import { listVideoGenerationHolds } from "@noelle/runtime/video-generation-holds-db";
import { retryVideoTeardown } from "@noelle/runtime/video-teardown-claims-db";
import { retryRecordingBrief } from "@noelle/runtime/video-recording-brief-db";
import { NoelleError, type NoelleContext } from "../context.js";
import { guard, text } from "../result.js";
import type { ToolModule } from "../types.js";
import { ORG_PROP } from "./_shared.js";

const scope = { org: z.string().trim().min(1).optional(), instanceId: z.string().uuid() };
const ListSchema = z.object({ ...scope, kind: z.enum(["all", "teardown", "recording_brief"]).default("all"),
  limit: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(1024).optional() }).strict();
const RetryBaseSchema = z.object({ ...scope, expectedClaimUUID: z.string().uuid(),
  acknowledgeUnresolvedOperation: z.literal(true) }).strict();
const RetrySchema = RetryBaseSchema.extend({ clipId: z.string().uuid() });
const RetryBriefSchema = RetryBaseSchema.extend({ draftId: z.string().uuid() });
const UUID_PROP = { type: "string", format: "uuid" } as const;
const RETRY_PROPS = { org: ORG_PROP, instanceId: UUID_PROP, expectedClaimUUID: UUID_PROP,
  acknowledgeUnresolvedOperation: { type: "boolean", const: true } };

export const videoClaimsModule: ToolModule = {
  tools: [
    { name: "noelle_list_video_generation_holds",
      description: "List one bounded page of unresolved Video teardown and recording-brief attempt identities for an instance. Returns exact status, reason and cursor; no generation or network dispatch.",
      inputSchema: { type: "object", properties: { org: ORG_PROP, instanceId: UUID_PROP,
        kind: { type: "string", enum: ["all", "teardown", "recording_brief"], default: "all" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 }, cursor: { type: "string", maxLength: 1024 } },
        required: ["instanceId"], additionalProperties: false } },
    { name: "noelle_retry_video_teardown",
      description: "Explicitly supersede one exact held teardown attempt and queue a new retained attempt. The prior provider operation may still be unresolved. Requires acknowledgement of that uncertainty. Queues only; performs no generation or network request. Completed attempts cannot be reset.",
      inputSchema: { type: "object", properties: { ...RETRY_PROPS, clipId: UUID_PROP },
        required: ["instanceId", "clipId", "expectedClaimUUID", "acknowledgeUnresolvedOperation"], additionalProperties: false } },
    { name: "noelle_retry_recording_brief",
      description: "Explicitly supersede one exact held recording-brief attempt and queue a new retained attempt for its approved draft. The prior provider operation may still be unresolved. Requires acknowledgement; queues only, with no generation or network request. Completed briefs cannot be reset.",
      inputSchema: { type: "object", properties: { ...RETRY_PROPS, draftId: UUID_PROP },
        required: ["instanceId", "draftId", "expectedClaimUUID", "acknowledgeUnresolvedOperation"], additionalProperties: false } },
  ],
  async handle(name, args, ctx: NoelleContext) {
    if (name === "noelle_list_video_generation_holds") return guard(async () => {
      const parsed = ListSchema.safeParse(args);
      if (!parsed.success) throw new NoelleError("Invalid Video generation hold inputs.");
      const input = parsed.data; const org = await ctx.resolveOrg(input.org);
      const page = await listVideoGenerationHolds(ctx.sql, { orgId: org.orgId, instanceId: input.instanceId,
        kind: input.kind, limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) });
      return text(JSON.stringify(page, null, 2));
    });
    if (name === "noelle_retry_video_teardown" || name === "noelle_retry_recording_brief") return guard(async () => {
      const brief = name === "noelle_retry_recording_brief";
      ctx.assertWritable(brief ? "queue a recording brief retry" : "queue a Video teardown retry");
      const parsed = (brief ? RetryBriefSchema : RetrySchema).safeParse(args);
      if (!parsed.success) throw new NoelleError("Retry requires valid identities and acknowledgeUnresolvedOperation:true.");
      const input = parsed.data; const org = await ctx.resolveOrg(input.org);
      const common = { orgId: org.orgId, instanceId: input.instanceId, expectedClaimUUID: input.expectedClaimUUID, operatorId: ctx.operatorId() };
      const id = "draftId" in input ? await retryRecordingBrief(ctx.sql, { ...common, draftId: input.draftId })
        : await retryVideoTeardown(ctx.sql, { ...common, clipId: input.clipId });
      if (!id) throw new NoelleError("The expected generation attempt is stale, completed or ineligible; no retry was queued.");
      return text(JSON.stringify({ status: "queued", claimId: id, providerExecutionMayBeUnresolved: true }));
    });
    return null;
  },
};

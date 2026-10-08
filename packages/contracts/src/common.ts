import { z } from "zod";

export const UuidSchema = z.string().uuid();
export type Uuid = z.infer<typeof UuidSchema>;

export const TimestampSchema = z.string().datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

export const AngleSchema = z.enum(["empathetic", "technical", "contrarian"]);
export type Angle = z.infer<typeof AngleSchema>;

export const ApprovalStatusSchema = z.enum([
  "pending",
  "sent",
  "skipped",
  "expired",
  "errored",
  // A DM parked via "Wait for reply": dropped off the pending inbox and shown
  // on the person's Contacts page with a "Send DM" button, to send by hand once
  // they reply on X. (Plain text status — approvals.status has no CHECK.)
  "deferred",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const SOCIAL_AGENT_ROLES = ["x_intern", "linkedin_intern", "reddit_intern", "video_intern"] as const;
export const AgentRoleSchema = z.enum(SOCIAL_AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export function isSocialAgentRole(role: string): role is AgentRole {
  return SOCIAL_AGENT_ROLES.some((candidate) => candidate === role);
}

export const BucketSchema = z.enum([
  "drafter",
  "drafter-bedrock",
  "drafter-vertex",
  "classifier",
  "quality-gate",
  // Posts lane: idea synthesis (cheap model) vs the full post write (Opus-tier).
  // Separate buckets give the spend view clean per-stage cost visibility.
  "ideation",
  "post-drafter",
  "other",
]);
export type Bucket = z.infer<typeof BucketSchema>;

// Standard error envelope returned by every Hono route on non-2xx.
export const ErrorBodySchema = z.object({
  error: z.string(),
  detail: z.string().optional(),
  request_id: z.string().optional(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

import { z } from "zod";

/** Specific API hosts permitted by all browser actuator builds. */
export function actuatorApiHostPermissions(extraOrigins = ""): string[] {
  const origins = ["http://localhost", "http://127.0.0.1", "https://api.trynoelle.com",
    ...extraOrigins.split(",").map((origin) => origin.trim()).filter(Boolean)];
  return [...new Set(origins.map((origin) => {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.hostname.includes('*') || !['/', '/*'].includes(url.pathname)
      || url.search || url.hash) {
      throw new Error("Actuator API permissions require specific HTTP(S) origins.");
    }
    return `${url.protocol}//${url.hostname}/*`;
  }))];
}

export const PostTargetSchema = z.object({
  type: z.literal("post"),
  url: z.string().url(),
  activity_urn: z.string().nullable(),
  author_name: z.string().nullable(),
  /**
   * THREADING TARGET. When present, the actuator must answer UNDER this comment
   * (open its Reply box) instead of adding a comment to the post.
   *
   * A conversation reply posted at post level is not a reply: it is a second
   * top-level comment from the operator on a thread he already commented on.
   * An item that carries a threading target MUST thread or be skipped.
   *
   * Populated only for notification leads; the value is the lead's external_id
   * (`urn:li:comment:<id>`), which the notifications sweep captured as THEIR
   * reply's urn. See docs/notifications-actor.md.
   */
  comment_urn: z.string().nullish(),
  /**
   * Who wrote that comment, as LinkedIn renders the name. The actuator reads
   * back the reply box's pre-filled mention chip and refuses if it does not
   * match — an independent check that the click landed on the right comment,
   * because the cost of being wrong is a public reply to the wrong person.
   */
  comment_author_name: z.string().nullish(),
});

export const ProfileTargetSchema = z.object({
  type: z.literal("profile"),
  url: z.string().url(),
  public_id: z.string().nullable(),
  recipient_name: z.string().nullable(),
});

export const CommentItemSchema = z.object({
  approval_id: z.string().uuid(),
  draft_id: z.string().uuid(),
  lead_id: z.string().uuid(),
  kind: z.literal("reply"),
  body: z.string().min(1),
  target: PostTargetSchema,
});

export const DmItemSchema = z.object({
  approval_id: z.string().uuid(),
  draft_id: z.string().uuid(),
  lead_id: z.string().uuid(),
  kind: z.literal("dm"),
  body: z.string().min(1),
  target: ProfileTargetSchema,
});

export const ActionableLinkedInResponseSchema = z.object({
  comments: z.array(CommentItemSchema),
  dms: z.array(DmItemSchema),
});

export const LinkedInActivityEventSchema = z.object({
  type: z.enum(["like", "comment", "dm", "skip"]),
  approval_id: z.string().uuid().optional(),
  // `.nullish()` (accept null AND undefined), NOT `.optional()`: the extension
  // sends explicit JSON `null` for feed like/skip events that have no resolvable
  // post URN or scraped author (idle-likes, ambient reads). `.optional()` rejects
  // null → the WHOLE batch `.parse()` threw a 500 and NOTHING was inserted,
  // silently dropping even the comment-success rows in the same batch (which the
  // dedup-by-link + daily write-cap read back). Both columns are nullable text.
  activity_urn: z.string().nullish(),
  author_name: z.string().nullish(),
  reason: z.string().optional(),
  // For a "like" event, the LinkedIn reaction actually delivered (Voyager enum:
  // LIKE / PRAISE / EMPATHY / APPRECIATION / INTEREST / ENTERTAINMENT). The
  // actuator varies these with an inclination to Like, Support, and Celebrate;
  // absent/"LIKE" both mean a plain like. Optional + backward-compatible.
  reaction: z.enum(["LIKE", "PRAISE", "EMPATHY", "APPRECIATION", "INTEREST", "ENTERTAINMENT"]).optional(),
  at: z.string(),
});

export const LinkedInActivityInSchema = z.object({
  session_id: z.string().uuid(),
  events: z.array(LinkedInActivityEventSchema).min(1).max(200),
});

// Actuator → api-vm: flip the master reply switch (agent_instances.reply_send_enabled)
// for one instance. The extension calls this with enabled=true when the operator
// explicitly starts a Run/Drain (their consent to post), and enabled=false when the
// run ends (fail-closed at rest). Token-authed + org-scoped server-side.
export const ActuatorEnableSendInSchema = z.object({
  instanceId: z.string().uuid(),
  enabled: z.boolean(),
});

export const ActuatorEnableSendResultSchema = z.object({
  ok: z.literal(true),
  instanceId: z.string().uuid(),
  reply_send_enabled: z.boolean(),
  // The value of reply_send_enabled BEFORE this write. Lets the extension arm
  // transition-aware: a manual Run/Drain only "owns" the switch (and may disarm
  // it at run end) when prior===false — i.e. THIS run performed the OFF→ON
  // transition. When the flag was already ON (prior===true) the enable was a
  // no-op against the operator's STANDING consent (the dashboard toggle that
  // drives the documented lights-out workflow), which is never the extension's
  // to flip back OFF. Optional for backward compatibility: an older api-vm
  // omits it, and callers MUST treat a missing prior as prior=true (fail-safe:
  // never disarm standing consent on uncertainty).
  prior: z.boolean().optional(),
});

// ── Remote actuator start/stop (the "hands" master switch) ──────────────────
// Shared by all three actuators (X / LinkedIn / Reddit). The operator's intent
// lives on agent_instances.actuator_desired_state (0089); the extension reads it
// over a long-poll and reconciles its run lifecycle to match, then acks its real
// state back. See docs/actuator-remote-control.md.

// Server → actuator: the current remote intent for one instance.
//   desired  = 'running' (run persistently / Full-auto) | 'stopped' (fully pause)
//              | null (no remote override — the extension's local autonomy governs).
//   commandAt = epoch-ms of the last desired-state change, or null if never set.
//              The extension passes this back as `since` so the next long-poll
//              blocks until it advances (a real change) instead of busy-looping.
export const ActuatorIntentResponseSchema = z.object({
  desired: z.enum(["running", "stopped"]).nullable(),
  commandAt: z.number().int().nonnegative().nullable(),
});

// Actuator → server: report the extension's ACTUAL run state (liveness), and —
// ONLY on an explicit LOCAL panel action (Full-automatic / STOP) — publish the
// operator's new intent so the local panel and the remote switch never disagree.
// `setDesired` is omitted on routine acks (the reconcile loop, autonomy-driven
// state changes), so a normal ack never fights the operator's server value.
export const ActuatorIntentAckInSchema = z.object({
  instanceId: z.string().uuid(),
  runState: z.enum(["running", "idle"]),
  setDesired: z.enum(["running", "stopped"]).optional(),
});

export const ActuatorIntentAckResultSchema = z.object({
  ok: z.literal(true),
  instanceId: z.string().uuid(),
});

export type ActuatorIntentResponse = z.infer<typeof ActuatorIntentResponseSchema>;
export type ActuatorIntentAckIn = z.infer<typeof ActuatorIntentAckInSchema>;
export type ActuatorIntentAckResult = z.infer<typeof ActuatorIntentAckResultSchema>;

export type ActionableItem =
  | z.infer<typeof CommentItemSchema>
  | z.infer<typeof DmItemSchema>;
export type ActionableLinkedInResponse = z.infer<typeof ActionableLinkedInResponseSchema>;
export type LinkedInActivityEvent = z.infer<typeof LinkedInActivityEventSchema>;
export type LinkedInActivityIn = z.infer<typeof LinkedInActivityInSchema>;
export type ActuatorEnableSendIn = z.infer<typeof ActuatorEnableSendInSchema>;
export type ActuatorEnableSendResult = z.infer<typeof ActuatorEnableSendResultSchema>;

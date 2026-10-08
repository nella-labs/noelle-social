import { z } from "zod";

// Per-lane enable/trigger state, stored on agent_instances.lane_config
// (0049_agent_instances_lane_config.sql). The multi-lane agent (Lyra now, Vega
// later) runs three independently triggerable lanes. An empty object means
// legacy behaviour — Replies on, DMs companion-only, Posts off — so existing
// instances are unchanged until the operator opts in. Resolve with
// resolveLaneConfig() to get a fully-defaulted object.
export const LaneConfigSchema = z
  .object({
    replies: z
      .object({
        enabled: z.boolean().default(true),
      })
      .strict()
      .optional(),
    dms: z
      .object({
        enabled: z.boolean().default(false),
        // Proactive intro/outreach DMs to watchlist people, decoupled from
        // whether they posted. Off by default (revives the old intro-DM lane as
        // a first-class, separately-triggerable thing).
        intro_dms_enabled: z.boolean().default(false),
        // Friendly relationship DMs grounded in saved person context. Off by
        // default and independent from reply companion DMs and intro DMs.
        relationship_dms_enabled: z.boolean().default(false),
      })
      .strict()
      .optional(),
    posts: z
      .object({
        enabled: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict();
export type LaneConfig = z.infer<typeof LaneConfigSchema>;

export type ResolvedLaneConfig = {
  replies: { enabled: boolean };
  dms: {
    enabled: boolean;
    intro_dms_enabled: boolean;
    relationship_dms_enabled: boolean;
  };
  posts: { enabled: boolean };
};

export const RELATIONSHIP_DM_DAILY_CAPS = { linkedin: 40, x: 15 } as const;

/** Fill defaults so callers never branch on undefined. */
export function resolveLaneConfig(raw: unknown): ResolvedLaneConfig {
  const parsed = LaneConfigSchema.safeParse(raw ?? {});
  const cfg: LaneConfig = parsed.success ? parsed.data : {};
  return {
    replies: { enabled: cfg.replies?.enabled ?? true },
    dms: {
      enabled: cfg.dms?.enabled ?? false,
      intro_dms_enabled: cfg.dms?.intro_dms_enabled ?? false,
      relationship_dms_enabled: cfg.dms?.relationship_dms_enabled ?? false,
    },
    posts: { enabled: cfg.posts?.enabled ?? false },
  };
}

/** Friendly DMs have their own switch; reply pauses and goals do not control it. */
export function isRelationshipDmEnabled(status: unknown, rawLaneConfig: unknown): boolean {
  return (status === "active" || status === "paused") &&
    resolveLaneConfig(rawLaneConfig).dms.relationship_dms_enabled;
}

export const LaneSchema = z.enum(["replies", "dms", "posts"]);
export type Lane = z.infer<typeof LaneSchema>;

// PUT /api/agents/:id/lane-config (JWT) — operator toggles a lane on/off.
export const LaneConfigUpdateSchema = z.object({
  lane: LaneSchema,
  enabled: z.boolean(),
  // Only meaningful for the dms lane.
  intro_dms_enabled: z.boolean().optional(),
});
export type LaneConfigUpdate = z.infer<typeof LaneConfigUpdateSchema>;

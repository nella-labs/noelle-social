import type { AvatarRole } from "@/components/constellation/Avatar";
import { LANE_VIEWS } from "@/lib/agent-content-config";

export type { ContentPlatform } from "@/lib/agent-content-config";

/**
 * Content workspace lane model — now a DERIVED SHIM over the canonical
 * `agent-content-config.ts`. The shape + values are byte-identical to what this
 * file used to hold as a literal, so its consumers (OverviewPanel / IdeasPanel /
 * DraftsPanel / ContentWeekPlanner) keep working unchanged. New code should read
 * `agent-content-config.ts` directly; this stays for the existing panels.
 */
export interface ContentLane {
  id: import("@/lib/agent-content-config").ContentPlatform;
  label: string;
  /** Agent name that owns this lane ("—" for the aggregate "All"). */
  agent: string;
  /** Avatar glyph role (1:1 with the agent registry); null for "All". */
  role: AvatarRole | null;
  /** Accent colour — a CSS custom property or an oklch() literal. */
  color: string;
  /** Short descriptor under the agent name in the switcher. */
  sub?: string;
  /** Badge the lane as newly shipped. */
  isNew?: boolean;
}

export const CONTENT_LANES: ContentLane[] = LANE_VIEWS.map((v) => ({
  id: v.platform,
  label: v.identity.label,
  agent: v.identity.agent,
  role: v.identity.glyph,
  color: v.identity.color,
  ...(v.identity.sub ? { sub: v.identity.sub } : {}),
  ...(v.identity.isNew ? { isNew: v.identity.isNew } : {}),
}));

export const LANE_BY_ID: Record<string, ContentLane> = Object.fromEntries(
  CONTENT_LANES.map((lane) => [lane.id, lane]),
);

/** The non-aggregate lanes (everything except "All"). */
export const PLATFORM_LANES: ContentLane[] = CONTENT_LANES.filter((l) => l.id !== "all");

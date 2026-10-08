import type { AvatarRole } from "@/components/constellation/Avatar";
import type { AgentRole } from "@noelle/contracts";

/**
 * Agent content-workspace descriptor — the single source of truth for the
 * `/content` workspace. Every shared workspace component (AgentWorkspaceShell,
 * WorkspaceNav, WorkspaceSectionOutlet, and the Schedule/Compose surfaces that
 * land in later steps) reads from ONE config per agent. Per-agent differences
 * are pure data: zero `role === "x_intern" ? … : …` branches survive in the
 * shared components.
 *
 * Relationship to the two descriptors that predate this:
 *  - `content-lanes.ts` (CONTENT_LANES) is now a *derived shim* of this file —
 *    it recomputes the same `ContentLane[]` so its existing consumers
 *    (OverviewPanel / IdeasPanel / DraftsPanel / ContentWeekPlanner) keep
 *    working byte-for-byte.
 *  - `agent-ui-config.ts` (AGENT_UI) stays separate: it describes the *agent
 *    detail page* (pipeline + watchlist), a different surface. The only overlap
 *    is the post/draft-only capability, kept consistent by a drift-guard test
 *    (`draftOnly === !supportsSendQueue`).
 *
 * SP0 is behavior-neutral: `sections` is the four boards that exist today
 * (overview · ideas · drafts · media). `schedule` and `compose` are appended
 * per-agent in their own steps, never to the "All" aggregate.
 */

export type ContentAgentRole = AgentRole;

export type ContentPlatform = "all" | "linkedin" | "x" | "reddit" | "video";

export type WorkspaceSection =
  // Phase-1 sections that exist today (map 1:1 to the `?board=` value):
  | "overview"
  | "ideas"
  | "drafts"
  | "media"
  // Phase-1 NEW sections, appended per-agent in their own steps:
  | "compose"
  | "schedule"
  | "inbox"
  // LATER phases:
  | "trending"
  | "performance"
  | "voice";

export type DraftKind = "reply" | "dm" | "post" | "video_script";

export interface HeaderAction {
  label: string;
  href: string;
  primary?: boolean;
}

export interface HeaderActionCtx {
  orgSlug: string;
  platform: ContentPlatform;
  /** Present for instance-scoped lanes (e.g. Nova) once the instance resolves. */
  instanceId?: string;
}

export interface WorkspaceIdentity {
  /** Agent name that owns this lane ("—" for the aggregate "All"). */
  agent: string;
  /** Switcher/title label ("X", "All", …). */
  label: string;
  /** Avatar glyph role (1:1 with the agent registry); null for "All". */
  glyph: AvatarRole | null;
  /** Accent colour — a CSS custom property or an oklch() literal. */
  color: string;
  /** Short descriptor under the agent name in the switcher ("" for "All"). */
  sub: string;
  /** Badge the lane as newly shipped. */
  isNew?: boolean;
}

export interface WorkspaceCopy {
  /** Header title is rendered `{titleLead}<em>{titleEm}</em>{titleTail}`. */
  titleLead?: string;
  titleEm: string;
  titleTail?: string;
  /** Full header subtitle. */
  sub: string;
  /** Optional per-section empty-state copy (panels supply their own otherwise). */
  emptyStates?: Partial<Record<WorkspaceSection, string>>;
}

/**
 * Scheduling parameters per agent. Consumed by the Schedule calendar + the
 * auto-publish / JIT-draft workers (Step 2). Only `canPost === true` agents
 * (Vega) ever reach the X-API write path; the values below are forward
 * declarations that Step 2 reconciles against `autosend-schedule.ts`.
 */
export interface SchedulingDescriptor {
  /** === capabilities.canAutoPost. Vega true; all others false. */
  canPost: boolean;
  /** Vega: 30 COMBINED posts + replies / day. Others: a soft daily target. */
  maxPerDay: number;
  minDelaySec: number;
  maxDelaySec: number;
  quietStartHourUtc: number;
  quietEndHourUtc: number;
  /** Default posting windows (UTC hours) the auto-picker spreads slots across. */
  defaultWindowsUtc: number[];
  /** Eager pre-draft window — near-term slots are drafted now. */
  predraftHorizonDays: number;
  /** JIT window — far-future empty slots materialise this long before slot_at. */
  jitHorizonHours: number;
}

export interface WorkspaceCapabilities {
  /** STATIC capability — Vega only. The live "auto-posting on" badge reads the DB. */
  canAutoPost: boolean;
  /** Reddit is view-only on Ideas (no in-app ideation). */
  canIdeate: boolean;
  draftKinds: DraftKind[];
  hasInboundReplies: boolean;
  hasEngagementData: boolean;
  hasTrending: boolean;
  hasVideoStudio: boolean;
}

/**
 * The narrow view the shell / nav / outlet consume. Both a real agent config
 * and the "All" aggregate satisfy it, so the chrome never special-cases.
 */
export interface WorkspaceLaneView {
  /** null = the aggregate "All" lane. */
  role: ContentAgentRole | null;
  platform: ContentPlatform;
  identity: WorkspaceIdentity;
  copy: WorkspaceCopy;
  sections: WorkspaceSection[];
  defaultSection: WorkspaceSection;
  /** "org" = cross-org reads; "instance" = per-agent-instance reads (Nova). */
  dataSource: "org" | "instance";
  headerActions: (ctx: HeaderActionCtx) => HeaderAction[];
}

export interface AgentContentConfig extends WorkspaceLaneView {
  role: ContentAgentRole;
  platform: Exclude<ContentPlatform, "all">;
  capabilities: WorkspaceCapabilities;
  source: {
    kind: "handles" | "connections" | "subreddits" | "creators";
    /** Watchlist tables that feed Trending (populated when Trending lands). */
    watchlistTables: string[];
  };
  scheduling: SchedulingDescriptor;
  /** === !capabilities.canAutoPost — the type-level draft-only marker. */
  draftOnly: boolean;
}

/** The aggregate "All" board set — overview · ideas · drafts · media. */
const BASE_SECTIONS: WorkspaceSection[] = ["overview", "ideas", "drafts", "media"];

/** Agent lanes additionally carry the Schedule calendar (the aggregate never does). */
const AGENT_SECTIONS: WorkspaceSection[] = ["overview", "compose", "ideas", "drafts", "schedule", "trending", "media", "performance", "voice"];

const GROUNDED = "Grounded in your vault voice and what actually performs.";

/** The two header actions shared by every text lane + the aggregate. */
function textHeaderActions(ctx: HeaderActionCtx): HeaderAction[] {
  const platformQs = ctx.platform !== "all" ? `&platform=${ctx.platform}` : "";
  return [
    { label: "◆ Voice vault", href: `/app/${ctx.orgSlug}/vault` },
    {
      label: "Generate ideas →",
      href: `/app/${ctx.orgSlug}/content?board=ideas${platformQs}`,
      primary: true,
    },
  ];
}

const VEGA: AgentContentConfig = {
  role: "x_intern",
  platform: "x",
  identity: { agent: "Vega", label: "X", glyph: "x-intern", color: "var(--accent)", sub: "replies · threads" },
  copy: { titleEm: "Vega", titleTail: " · X", sub: `Vega's lane · replies · threads. ${GROUNDED}` },
  sections: [...AGENT_SECTIONS],
  defaultSection: "overview",
  dataSource: "org",
  headerActions: textHeaderActions,
  capabilities: {
    canAutoPost: true,
    canIdeate: true,
    draftKinds: ["reply", "dm", "post"],
    hasInboundReplies: true,
    hasEngagementData: true,
    hasTrending: true,
    hasVideoStudio: false,
  },
  source: { kind: "handles", watchlistTables: [] },
  scheduling: {
    canPost: true,
    maxPerDay: 30,
    minDelaySec: 1800,
    maxDelaySec: 9000,
    quietStartHourUtc: 6,
    quietEndHourUtc: 13,
    defaultWindowsUtc: [14, 17, 21],
    predraftHorizonDays: 14,
    jitHorizonHours: 36,
  },
  draftOnly: false,
};

const LYRA: AgentContentConfig = {
  role: "linkedin_intern",
  platform: "linkedin",
  identity: { agent: "Lyra", label: "LinkedIn", glyph: "linkedin-intern", color: "var(--info)", sub: "posts · comments" },
  copy: { titleEm: "Lyra", titleTail: " · LinkedIn", sub: `Lyra's lane · posts · comments. ${GROUNDED}` },
  sections: [...AGENT_SECTIONS],
  defaultSection: "overview",
  dataSource: "org",
  headerActions: textHeaderActions,
  capabilities: {
    canAutoPost: false,
    canIdeate: true,
    draftKinds: ["reply", "dm", "post"],
    hasInboundReplies: false,
    hasEngagementData: false,
    hasTrending: false,
    hasVideoStudio: false,
  },
  source: { kind: "connections", watchlistTables: [] },
  scheduling: {
    canPost: false,
    maxPerDay: 4,
    minDelaySec: 1800,
    maxDelaySec: 9000,
    quietStartHourUtc: 6,
    quietEndHourUtc: 13,
    defaultWindowsUtc: [13, 16],
    predraftHorizonDays: 14,
    jitHorizonHours: 36,
  },
  draftOnly: true,
};

const ORION: AgentContentConfig = {
  role: "reddit_intern",
  platform: "reddit",
  identity: { agent: "Orion", label: "Reddit", glyph: "reddit-intern", color: "var(--ok)", sub: "replies" },
  copy: { titleEm: "Orion", titleTail: " · Reddit", sub: `Orion's lane · replies. ${GROUNDED}` },
  sections: [...AGENT_SECTIONS],
  defaultSection: "overview",
  dataSource: "org",
  headerActions: textHeaderActions,
  capabilities: {
    canAutoPost: false,
    canIdeate: false,
    draftKinds: ["reply", "post"],
    hasInboundReplies: false,
    hasEngagementData: false,
    hasTrending: false,
    hasVideoStudio: false,
  },
  source: { kind: "subreddits", watchlistTables: [] },
  scheduling: {
    canPost: false,
    maxPerDay: 4,
    minDelaySec: 1800,
    maxDelaySec: 9000,
    quietStartHourUtc: 6,
    quietEndHourUtc: 13,
    defaultWindowsUtc: [15, 23],
    predraftHorizonDays: 14,
    jitHorizonHours: 36,
  },
  draftOnly: true,
};

const NOVA: AgentContentConfig = {
  role: "video_intern",
  platform: "video",
  identity: { agent: "Nova", label: "Video", glyph: "video-intern", color: "oklch(0.58 0.13 305)", sub: "IG · TikTok", isNew: true },
  copy: {
    titleEm: "Nova",
    titleTail: " · Video",
    sub: "Nova's lane · IG · TikTok. Plan, structure, and script short-form video — grounded on what actually performs for the creators you watch. Nothing posts; you record by hand.",
  },
  sections: [...AGENT_SECTIONS],
  defaultSection: "overview",
  dataSource: "instance",
  headerActions: (ctx) =>
    ctx.instanceId
      ? [
          { label: "Creators & harvest →", href: `/app/${ctx.orgSlug}/agents/${ctx.instanceId}/watchlist` },
          { label: "My analytics →", href: `/app/${ctx.orgSlug}/agents/${ctx.instanceId}/analytics` },
          { label: "Brand Guide →", href: `/app/${ctx.orgSlug}/agents/${ctx.instanceId}/brand-guide` },
          { label: "◆ Voice vault", href: `/app/${ctx.orgSlug}/vault` },
        ]
      : [{ label: "◆ Voice vault", href: `/app/${ctx.orgSlug}/vault` }],
  capabilities: {
    canAutoPost: false,
    canIdeate: true,
    draftKinds: ["video_script"],
    hasInboundReplies: false,
    hasEngagementData: true,
    hasTrending: false,
    hasVideoStudio: true,
  },
  source: { kind: "creators", watchlistTables: [] },
  scheduling: {
    canPost: false,
    maxPerDay: 2,
    minDelaySec: 1800,
    maxDelaySec: 9000,
    quietStartHourUtc: 6,
    quietEndHourUtc: 13,
    defaultWindowsUtc: [16, 22],
    predraftHorizonDays: 14,
    jitHorizonHours: 36,
  },
  draftOnly: true,
};

/** The aggregate "All" lane — a view, not an agent. Never gains compose/schedule. */
export const ALL_AGGREGATE: WorkspaceLaneView = {
  role: null,
  platform: "all",
  identity: { agent: "—", label: "All", glyph: null, color: "var(--ink)", sub: "" },
  copy: {
    titleEm: "Content studio",
    sub: "Plan ideas, review drafts, and manage media across your content channels.",
  },
  sections: [...BASE_SECTIONS],
  defaultSection: "overview",
  dataSource: "org",
  headerActions: textHeaderActions,
};

export const AGENT_CONTENT_CONFIGS: Record<ContentAgentRole, AgentContentConfig> = {
  x_intern: VEGA,
  linkedin_intern: LYRA,
  reddit_intern: ORION,
  video_intern: NOVA,
};

/** Platform → config map (excludes the "all" aggregate). */
export const CONFIG_BY_PLATFORM: Record<Exclude<ContentPlatform, "all">, AgentContentConfig> = {
  x: VEGA,
  linkedin: LYRA,
  reddit: ORION,
  video: NOVA,
};

/** Switcher order: All first, then LinkedIn · X · Reddit · Video. */
export const LANE_VIEWS: WorkspaceLaneView[] = [
  ALL_AGGREGATE,
  LYRA,
  VEGA,
  ORION,
  NOVA,
];

export function platformToRole(platform: ContentPlatform): ContentAgentRole | null {
  if (platform === "all") return null;
  return CONFIG_BY_PLATFORM[platform].role;
}

export function roleToPlatform(role: ContentAgentRole): Exclude<ContentPlatform, "all"> {
  return AGENT_CONTENT_CONFIGS[role].platform;
}

/** Resolve the lane view for a `?platform=` value (defaults to the aggregate). */
export function configForPlatform(platform: ContentPlatform): WorkspaceLaneView {
  if (platform === "all") return ALL_AGGREGATE;
  return CONFIG_BY_PLATFORM[platform];
}

export function configForRole(role: ContentAgentRole): AgentContentConfig {
  return AGENT_CONTENT_CONFIGS[role];
}

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

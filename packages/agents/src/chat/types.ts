import type { AgentRole } from "../types.js";

/**
 * Chat profile for a Noelle agent.
 *
 * Lives alongside the agent's code class + manifest. Where the class
 * defines what the agent *does* autonomously and the manifest defines
 * how the agent appears in the hire UI, the chat profile defines how
 * the agent *talks* on its detail page — system prompt, greeting,
 * suggestion chips.
 *
 * Pure functions only. No Node deps, no DB access, no model calls.
 * The route layer (apps/app) is responsible for loading the live
 * context snapshot and passing it in; the profile only renders.
 */
export interface AgentChatProfile {
  readonly role: AgentRole;
  /** Compose the full system prompt from display name + live context. */
  systemPrompt(args: SystemPromptArgs): string;
  /** First-paint greeting + suggestion chips. No LLM call. */
  greeting(args: GreetingArgs): GreetingResult;
}

export interface SystemPromptArgs {
  /** Display name on the agent_instances row (falls back to manifest). */
  displayName: string;
  /** Live snapshot of what this agent has been doing — see context.ts. */
  context: AgentChatContext;
}

export interface GreetingArgs {
  displayName: string;
}

export interface GreetingResult {
  body: string;
  suggestions: string[];
}

/**
 * Live snapshot the route loads before each chat turn.
 *
 * Fields are optional because each role consumes a different slice and
 * a degraded snapshot (no DB, no permission, no rows) should still
 * produce a usable system prompt. Profiles that need a field but find
 * it missing should fall back to a neutral phrasing — never invent
 * numbers.
 */
export interface AgentChatContext {
  /** X intern: top pending approvals queued for the operator's review. */
  pendingApprovals?: ChatApprovalSummary[];
  /** X intern: total pending count (>= pendingApprovals.length). */
  totalPendingCount?: number;
  /** X intern: lifetime count of sent + skipped approvals. */
  totalSentLifetime?: number;
  /** X intern: when each pipeline worker last completed successfully. */
  workerFreshness?: ChatWorkerFreshness[];
  /** Recent activity rows shared by every role. */
  recentActivity?: ChatActivityEvent[];
  /**
   * Operator-set mission (agent_instances.objective), custom only — undefined
   * means "running on the manifest default". Lets the chat tell the operator
   * what its current mission is and propose changes to it.
   */
  objective?: string;
  /**
   * X intern: what the agent is currently hunting for (its x_watchlist).
   * Handles carry no leading @. Lets the chat propose precise add/remove diffs
   * against what already exists instead of guessing.
   */
  targeting?: ChatTargeting;
  /**
   * X intern: the best current leads, pulled straight from `noelle.leads`
   * (broader than the approvals queue — includes leads not yet drafted). Lets
   * the chat answer "show me the best leads" with real rows + reply links
   * instead of describing only what already has a draft.
   */
  bestLeads?: ChatLeadSummary[];
  /**
   * Video intern (Nova): the distilled Brand Guide + the top harvested clips.
   * Lets the chat answer "what's working in my niche?" / "what makes my top
   * creator's videos work?" with the real distillation + real metrics, instead
   * of guessing. Empty/undefined until a harvest + distill has run.
   */
  videoIntel?: ChatVideoIntel;
  /**
   * Video intern (Nova): the specific draft the operator has open in the Drafts
   * studio right now. Present only when the chat is launched from a draft's
   * "Refine" button (the studio passes its id). With it, Nova can ground every
   * suggestion in the actual hook/beats/script/visuals on screen instead of
   * talking about the niche in the abstract.
   */
  currentDraft?: ChatVideoDraft;
}

/**
 * The video draft the operator is actively editing in the studio — the unit the
 * "Refine" chat is about. All text is as last saved (the chat loads it from the
 * DB by id); unsaved keystrokes in the editor aren't reflected.
 */
export interface ChatVideoDraft {
  /** The idea/hook this draft is built on. */
  hook: string;
  /** draft / ready / published. */
  status: string;
  /** The timed beats (the storyboard) — voice line + purpose per beat. */
  beats: ChatVideoBeat[];
  /** The full script as last saved (final_script ?? script). Truncate before display. */
  script: string;
  /** Short labels for the on-screen visuals Nova generated (charts/lower-thirds). */
  visuals: string[];
  /** Suggested soundtrack names, if any. */
  sounds: string[];
  /** The creators this draft was modeled on (handles, no leading @). */
  inspiredBy: string[];
  /**
   * The exemplar reels this draft was scripted from, WITH the teardown Nova
   * extracted (why it worked + its hook) — the same grounding the scripter used.
   * Lets the refiner reason from the real reels, not just their handles.
   */
  inspirations?: ChatVideoInspiration[];
  /**
   * A snippet of the operator's own voice/brand (from the vault) the scripter
   * grounded the substance on. Undefined when no vault is wired.
   */
  voice?: string;
}

export interface ChatVideoInspiration {
  /** Creator handle, no leading @. */
  handle: string;
  views: number | null;
  /** Recorded views ÷ captured followers, when both are measured and followers > 0. */
  reachMultiple: number | null;
  /** The reel's hook line, from the teardown. */
  hook?: string;
  /** Nova's grounded "why it worked" hypothesis, from the teardown. */
  whyItWorked?: string;
}

export interface ChatVideoBeat {
  /** Beat start, seconds. */
  tStart: number;
  /** Beat end, seconds. */
  tEnd: number;
  /** What this beat is for (hook / claim / payoff …). */
  purpose: string;
  /** The voice line the operator reads over this beat. */
  line: string;
}

export interface ChatVideoIntel {
  /** Per-creator / per-niche / your-account distillations (the Brand Guide). */
  brandGuide: ChatVideoBrandGuideEntry[];
  /** The strongest harvested clips by views — evidence for "what's working". */
  topClips: ChatVideoClip[];
}

export interface ChatVideoBrandGuideEntry {
  scope: "creator" | "niche" | "account";
  /** Creator handle, niche query, or "your account". */
  subject: string;
  /** One-line distillation (hooks / transitions / structure). */
  summary: string;
  /** How many clips the distillation is grounded on. */
  clipsAnalyzed: number | null;
}

export interface ChatVideoClip {
  /** Creator handle, no leading @. */
  handle: string;
  views: number | null;
  /** Caption / hook line. Truncate before display. */
  caption: string;
}

export interface ChatTargeting {
  handles: string[];
  keywords: string[];
}

export interface ChatApprovalSummary {
  approvalId: string;
  /** @example "marcus_h_writes" — never include the leading @. */
  authorHandle: string | null;
  /** Post the agent is replying to. Truncate before display. */
  postText: string;
  /** Which of the 3 drafted angles is currently selected. */
  selectedAngle: "empathetic" | "technical" | "contrarian" | null;
  /** Drafter output for the selected angle. */
  draftBody: string;
  /** Optional T1/T2/T3 ranking from the classifier. */
  tier: "T1" | "T2" | "T3" | null;
  /** 0–100 score the classifier assigned. */
  velocityScore: number | null;
  /** When the approval row was created. ISO 8601. */
  createdAt: string;
  /** X post id of the lead being replied to, when known. */
  postId?: string | null;
  /**
   * Direct X reply link, prefilled with the drafted reply — "click to send".
   * Built from the lead's post id + the selected draft body.
   */
  replyUrl?: string | null;
}

/**
 * A lead straight off `noelle.leads` (not necessarily drafted yet). Powers
 * the "show me the best leads" answer with real, actionable rows.
 */
export interface ChatLeadSummary {
  /** Author handle, no leading @. */
  handle: string | null;
  /** T1/T2/T3 ranking from the classifier. */
  tier: "T1" | "T2" | "T3" | null;
  /** Classifier score. */
  score: number | null;
  /** The post being targeted. Truncate before display. */
  postText: string;
  /** X post id, when known. */
  postId: string | null;
  /** Link to view the original post. */
  originalPostUrl: string | null;
  /** Direct X reply-composer link for this lead. */
  replyUrl: string | null;
  /** Whether the drafter has already produced a draft for this lead. */
  hasDraft: boolean;
}

export interface ChatWorkerFreshness {
  worker:
    | "discovery"
    | "classifier"
    | "drafter"
    | "send"
    // Nova's video pipeline workers.
    | "harvester"
    | "teardown"
    | "distiller"
    | "ideator"
    | "scripter";
  lastSuccessAt: string | null;
}

export interface ChatActivityEvent {
  when: string;
  verb: string;
  what: string;
}

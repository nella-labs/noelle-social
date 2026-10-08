/**
 * Per-intern UI capability registry.
 *
 * Vega (x_intern) and Lyra (linkedin_intern) render the SAME detail-page shell,
 * pipeline panel, and watchlist panel — they differ only in copy, which
 * "Tailor this run" fields apply, and a few capability flags. Centralising that
 * here keeps the components agent-agnostic (they consume a config object) instead
 * of sprinkling `isXIntern ? … : …` branches across page.tsx, PipelinePanel, and
 * the watchlist surfaces.
 *
 * This is UI-only metadata. The data layer (which workers exist, which discovery
 * fields a tick honours) is enforced in queries.ts + the worker apps; this file
 * just tells the React tree how to label + lay them out.
 */

import { isSocialAgentRole, type AgentRole } from "@noelle/contracts";

export type InternRole = AgentRole;

/** Roles that render the intern detail experience (pipeline + watchlist). */
export function isInternRole(role: string | null | undefined): role is InternRole {
  return typeof role === "string" && isSocialAgentRole(role);
}

/**
 * Roles parked in maintenance mode. Their automatic work is switched off at the
 * worker (Nova's own-account sweep defaults OFF — see NOELLE_VIDEO_SELF_TRACK)
 * and their run controls are disabled in the UI, with this note shown to the
 * operator. Nova (video_intern) is parked while focus is on the text platforms
 * (Vega, Lyra, Orion). Remove the entry + set NOELLE_VIDEO_SELF_TRACK=1 to
 * bring an agent back.
 */
export const MAINTENANCE_NOTE_BY_ROLE: Partial<Record<InternRole, string>> = {
  video_intern:
    "Automatic short video harvesting is unavailable. Your existing clips, ideas, and script tools remain available.",
};

/** The maintenance note for a role, or null if the agent is not parked. */
export function maintenanceNote(role: string | null | undefined): string | null {
  return isInternRole(role) ? (MAINTENANCE_NOTE_BY_ROLE[role] ?? null) : null;
}

/** A numeric field in the "Tailor this run" form. `key` indexes DiscoveryConfig. */
export interface TailorNumberField {
  key:
    | "timeWindowHours"
    | "postsPerSource"
    | "minFaves"
    | "minReplies"
    | "minReactions"
    | "minComments";
  label: string;
  placeholder: string;
  /** Tooltip / help text. */
  title: string;
  min: number;
  max: number;
  /**
   * Empty input => null ("filter off"). postsPerSource is the one field that
   * can't be null (a tick always pulls *some* posts), so it's `false`.
   */
  nullable: boolean;
}

/** An X-only boolean filter (`-filter:…` operator). */
export interface TailorBooleanField {
  key: "excludeRetweets" | "excludeReplies";
  label: string;
}

export interface PipelineUi {
  /** Goal-run noun: "Get me N <goalNoun>". */
  goalNoun: string;
  /** Drafter worker's one-line role (the generic ROLE map is X-flavoured). */
  drafterRole: string;
  /**
   * Explanation shown under the worker rows when the instance is paused. Agent-
   * specific: X/LinkedIn keep an always-on watchlist lane (+ profiler) running
   * while paused, but Reddit's watchlist is *subreddits* — its only lane — so a
   * paused Orion sleeps the whole pipeline. See PipelinePanel.
   */
  pausedNote: string;
  /** Numeric tailor-run fields, in render order. */
  tailorFields: TailorNumberField[];
  /** X-only boolean filters. Empty => the boolean row is hidden. */
  tailorBooleans: TailorBooleanField[];
  /** X-only two-letter `lang:` filter. */
  tailorLang: boolean;
  /** Footnote under the tailor form. */
  tailorFootnote: string;
}

export interface WatchlistUi {
  /** Card heading. */
  title: string;
  /** One-line helper under the heading. */
  helper: string;
  /** Left-rail summary blurb (detail page). */
  summary: string;
  /** Whether per-person objectives (WATCHLIST_OBJECTIVES) apply. */
  objectives: boolean;
  /** Manual-add form: label for the identifier input + its placeholder. null = no manual add. */
  add: { fieldLabel: string; placeholder: string } | null;
}

export interface AgentUiConfig {
  role: InternRole;
  /** Whether this intern posts (Vega) vs draft-only (Lyra). Gates the Send queue. */
  supportsSendQueue: boolean;
  pipeline: PipelineUi;
  watchlist: WatchlistUi;
}

const X_INTERN: AgentUiConfig = {
  role: "x_intern",
  supportsSendQueue: true,
  pipeline: {
    goalNoun: "leads with replies + DMs ready",
    drafterRole: "generates the replies + DMs",
    pausedNote:
      "Paused — the keyword pipeline is stopped. The Watchlist lane still drafts replies to your watched people, and the Profiler keeps building their profiles; the other switches apply only while active.",
    tailorFields: [
      {
        key: "timeWindowHours",
        label: "Posts from the last (hours)",
        placeholder: "any time",
        title:
          "Only ingest posts newer than N hours. Empty = no window. Applies to handles + keywords.",
        min: 1,
        max: 168,
        nullable: true,
      },
      {
        key: "postsPerSource",
        label: "Posts per source",
        placeholder: "20",
        title: "How many tweets to pull per handle/keyword each tick (5–100).",
        min: 5,
        max: 100,
        nullable: false,
      },
      {
        key: "minFaves",
        label: "Min likes (keywords)",
        placeholder: "none",
        title: "Keyword search only: drop posts below this like count (X min_faves:).",
        min: 0,
        max: 1_000_000,
        nullable: true,
      },
      {
        key: "minReplies",
        label: "Min replies (keywords)",
        placeholder: "none",
        title: "Keyword search only: drop posts below this reply count (X min_replies:).",
        min: 0,
        max: 1_000_000,
        nullable: true,
      },
    ],
    tailorBooleans: [
      { key: "excludeRetweets", label: "Exclude retweets" },
      { key: "excludeReplies", label: "Exclude replies" },
    ],
    tailorLang: true,
    tailorFootnote:
      "Applies to the next run only. Engagement + post-type + language filters affect keyword search; the time window + posts-per-source affect both. Edit the saved default under Configure agent → Discovery.",
  },
  watchlist: {
    title: "Watchlist",
    helper:
      "Everyone here gets a reply (and DM) to every new post, from the day you add them. Pick an objective to steer how Vega engages each person.",
    summary:
      "Who Vega always replies to, plus the handles & keywords it sweeps for fresh leads each cycle.",
    objectives: true,
    add: { fieldLabel: "handle", placeholder: "patio11" },
  },
};

const LINKEDIN_INTERN: AgentUiConfig = {
  role: "linkedin_intern",
  supportsSendQueue: false,
  pipeline: {
    goalNoun: "posts with reply drafts ready",
    drafterRole: "drafts the reply (never sends)",
    pausedNote:
      "Paused — the keyword pipeline is stopped. The Watchlist lane still drafts replies to your watched people, and the Profiler keeps building their profiles; the other switches apply only while active.",
    // LinkedIn discovery has two lanes over Apify post payloads (posted-at +
    // reaction/comment counts): the watch lane (watched connections' posts) and
    // the search lane (keyword search LinkedIn-wide). A time window + engagement
    // floors apply to both, unlike X's search-operator-only filters. No
    // retweet/reply/lang operators (those are X search syntax).
    tailorFields: [
      {
        key: "timeWindowHours",
        label: "Posts from the last (hours)",
        placeholder: "any time",
        title:
          "Only draft for posts newer than N hours (both lanes). Empty = no window.",
        min: 1,

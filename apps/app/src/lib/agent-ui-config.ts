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
        max: 168,
        nullable: true,
      },
      {
        key: "postsPerSource",
        label: "Posts per connection",
        placeholder: "20",
        title: "How many recent posts to sweep per watched connection each tick (5–100).",
        min: 5,
        max: 100,
        nullable: false,
      },
      {
        key: "minReactions",
        label: "Min reactions",
        placeholder: "none",
        title:
          "Reaction floor: filters the watch lane AND sets the search lane's high-engagement floor (a default applies when empty).",
        min: 0,
        max: 1_000_000,
        nullable: true,
      },
      {
        key: "minComments",
        label: "Min comments",
        placeholder: "none",
        title: "Skip watched-connection posts below this comment count.",
        min: 0,
        max: 1_000_000,
        nullable: true,
      },
    ],
    tailorBooleans: [],
    tailorLang: false,
    tailorFootnote:
      "Applies to the next run only. Lyra sweeps watched connections AND searches your keywords; the window + engagement floors decide which posts earn a draft. Edit the saved default under Configure agent → Discovery.",
  },
  watchlist: {
    title: "Watchlist",
    helper:
      "Two lanes. People are connections Lyra always watches — every new post earns a drafted reply. Keywords are topics she searches LinkedIn-wide for high-engagement posts from outside your network. Pick an objective to steer how she engages.",
    summary:
      "Connections Lyra always replies to, plus the keywords she searches LinkedIn-wide for high-engagement posts. She drafts replies only (DMs off by default) and never posts.",
    objectives: true,
    add: { fieldLabel: "LinkedIn URL or handle", placeholder: "linkedin.com/in/patio11" },
  },
};

const REDDIT_INTERN: AgentUiConfig = {
  role: "reddit_intern",
  supportsSendQueue: false,
  pipeline: {
    goalNoun: "threads with reply drafts ready",
    drafterRole: "drafts the reply (never posts)",
    pausedNote:
      "Paused — Orion is asleep. Its only lane is the subreddit watchlist, so discovery, the classifier, and the drafter all stop until you start it again. (No profiler, no DMs — those are LinkedIn-only.)",
    // Reddit discovery sweeps a subreddit watchlist over the Apify Reddit actor
    // (posted-at + score/comment counts). A time window + engagement floors
    // apply, mirroring LinkedIn's two-number model (no retweet/reply/lang
    // operators — those are X search syntax).
    tailorFields: [
      {
        key: "timeWindowHours",
        label: "Posts from the last (hours)",
        placeholder: "any time",
        title:
          "Only draft for threads newer than N hours. Empty = no window.",
        min: 1,
        max: 168,
        nullable: true,
      },
      {
        key: "postsPerSource",
        label: "Posts per subreddit",
        placeholder: "20",
        title: "How many recent threads to sweep per watched subreddit each tick (5–100).",
        min: 5,
        max: 100,
        nullable: false,
      },
      {
        key: "minReactions",
        label: "Min upvotes",
        placeholder: "none",
        title:
          "Upvote floor: skip threads below this score. A default applies when empty.",
        min: 0,
        max: 1_000_000,
        nullable: true,
      },
      {
        key: "minComments",
        label: "Min comments",
        placeholder: "none",
        title: "Skip threads below this comment count.",
        min: 0,
        max: 1_000_000,
        nullable: true,
      },
    ],
    tailorBooleans: [],
    tailorLang: false,
    tailorFootnote:
      "Applies to the next run only. Orion sweeps your watched subreddits; the window + engagement floors decide which threads earn a draft. Edit the saved default under Configure agent → Discovery.",
  },
  watchlist: {
    title: "Subreddits",
    helper:
      "The subreddits Orion watches. Every in-ICP thread in one earns a drafted reply. Give a subreddit an objective to steer how Orion engages, and a min score to skip low-signal threads.",
    summary:
      "The subreddits Orion sweeps for in-ICP threads. She drafts on-brand replies and auto-sends the approved ones via the Reddit actuator.",
    objectives: true,
    add: { fieldLabel: "subreddit", placeholder: "SaaS" },
  },
};

const VIDEO_INTERN: AgentUiConfig = {
  role: "video_intern",
  supportsSendQueue: false,
  pipeline: {
    goalNoun: "top videos harvested + analysed",
    drafterRole: "scripts the video (never posts)",
    pausedNote:
      "Paused — Nova is asleep. Harvest + analysis only run when you trigger them, so nothing happens until you start it again.",
    tailorFields: [],
    tailorBooleans: [],
    tailorLang: false,
    tailorFootnote:
      "Nova tunes via its harvest filters (top-by-views, outperformers, niche-trending) on the watchlist, not a per-run form.",
  },
  watchlist: {
    title: "Creators",
    helper:
      "The IG/TikTok creators Nova studies, plus niche keyword/hashtag lanes. Each harvest pulls their top-performing reels (by your filters) and breaks down what makes them work.",
    summary:
      "The creators + niches Nova learns from. It harvests their top videos, distils a Video Brand Guide, and helps you script your own. Never posts.",
    objectives: false,
    add: { fieldLabel: "creator handle", placeholder: "chrisdoesviral" },
  },
};

export const AGENT_UI: Record<InternRole, AgentUiConfig> = {
  x_intern: X_INTERN,
  linkedin_intern: LINKEDIN_INTERN,
  reddit_intern: REDDIT_INTERN,
  video_intern: VIDEO_INTERN,
};

/** Resolve the UI config for an instance role; null for non-intern roles. */
export function agentUiFor(role: string | null | undefined): AgentUiConfig | null {
  return isInternRole(role) ? AGENT_UI[role] : null;
}

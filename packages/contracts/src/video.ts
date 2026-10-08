import { z } from "zod";

// Nova (video_intern) contracts — the Instagram/TikTok short-form video
// intelligence agent. Nova is the Account Feeder pattern upgraded for video:
// where the text feeder distils WRITING VOICE from harvested posts into
// account_ultra_profiles, Nova distils VIDEO STRUCTURE (hooks, beats,
// transitions, pacing, CTAs, sounds, on-screen graphics) from harvested viral
// reels into a "Video Brand Guide" the generator grounds on.
//
// Stored shapes only live here (the jsonb columns + curated rows). Wire
// request/response schemas for the studio generation lane are added alongside
// the api-vm routes that need them (mirrors posts.ts), and the harvester /
// teardown workers write to Cloud SQL directly (like the account feeder), so
// they need no JWT route here in v1.

// One agent, two platforms. Multi-platform via this column, exactly like
// post_ideas was widened across the growth interns.
export const VideoPlatformSchema = z.enum(["instagram", "tiktok"]);
export type VideoPlatform = z.infer<typeof VideoPlatformSchema>;

// ---------------------------------------------------------------------------
// Watchlist — the curated creators + niche lanes Nova harvests from.
// ---------------------------------------------------------------------------

// One curated creator to learn from (a noelle.video_watchlist_sources row).
// `handle` is trimmed/lowercased so the (instance, platform, handle) unique key
// stays stable.
export const VideoWatchlistSourceSchema = z
  .object({
    /** Creator handle (no leading @). Trimmed + lowercased for a stable key. */
    handle: z.string().trim().toLowerCase().min(1, "handle is required"),
    platform: VideoPlatformSchema.default("instagram"),
    /** Optional human-friendly name for the dashboard. */
    displayName: z.string().trim().optional(),
    /** Optional operator note ("why we watch this creator"). */
    note: z.string().trim().optional(),
    /** Whether this source is pulled on the next harvest run. */
    enabled: z.boolean().default(true),
  })
  .strict();
export type VideoWatchlistSource = z.infer<typeof VideoWatchlistSourceSchema>;

// One niche lane — "newest videos that perform best in a niche" (a
// noelle.video_watchlist_niches row). `query` is a keyword or hashtag (no #).
export const VideoWatchlistNicheSchema = z
  .object({
    query: z.string().trim().min(1, "query is required"),
    platform: VideoPlatformSchema.default("instagram"),
    note: z.string().trim().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type VideoWatchlistNiche = z.infer<typeof VideoWatchlistNicheSchema>;

// ---------------------------------------------------------------------------
// Feeder config — the harvest filters + generation knobs the operator tunes.
// Stored in agent_instances.video_feeder_config (NULL column = Nova feeder OFF;
// a present, even empty object turns it ON with these defaults). Every key has a
// sensible default so an empty object reproduces default behaviour.
// ---------------------------------------------------------------------------
export const VideoFeederConfigSchema = z
  .object({
    // --- Harvest filters (per source) ---
    /** Keep the top-N clips by view count. 0 = lane off. */
    topByViews: z.number().int().min(0).max(100).default(10),
    /** Keep the top-N clips by engagement rate. 0 = lane off. */
    topByEngagement: z.number().int().min(0).max(100).default(0),
    /**
     * "Doubled their follower count in views" — clips whose views ÷ author
     * follower_count is at/above `ratio`, EXCLUDING any already picked by the
     * top-N lanes (deduped). Captures audience-relative virality.
     */
    outperformers: z
      .object({
        ratio: z.number().min(1).default(2),
        n: z.number().int().min(0).max(100).default(10),
      })
      .strict()
      .default({ ratio: 2, n: 10 }),
    /** Cap on total clips pulled per source per run (cost guard). */
    maxPerSource: z.number().int().min(1).max(200).default(30),
    /** Only consider clips posted within this many days. */
    recencyWindowDays: z.number().int().min(1).max(365).default(90),
    // --- Niche lanes ("newest top performers in a niche") ---
    nicheTrending: z
      .object({
        recencyWindowHours: z.number().int().min(1).max(720).default(168),
        minViews: z.number().int().min(0).default(0),
        n: z.number().int().min(0).max(100).default(10),
      })
      .strict()
      .default({ recencyWindowHours: 168, minViews: 0, n: 10 }),
    // --- Analysis tiering ---
    /**
     * Auto-flag clips at/above this view percentile for the expensive cloud
     * "deep" teardown pass (Gemini 2.5 Pro + Bedrock). Below it, clips get the
     * cheap bulk pass (Gemini Flash / claude-cli). 100 = never auto-flag.
     */
    deepTierPercentile: z.number().min(0).max(100).default(90),
    // --- Generation knobs (mirror the account feeder's style selection) ---
    /** How many video exemplars to ground each generated script on. */
    maxVideoExemplars: z.number().int().min(0).max(20).default(4),
    /** 0 = always best-fit exemplars; 1 = max variety in the weighted sample. */
    varietyTemperature: z.number().min(0).max(1).default(0.4),
    /** Engagement floor (percentile) for exemplar eligibility. 0 = no floor. */
    minPerformancePercentile: z.number().min(0).max(100).default(0),
  })
  .strict();
export type VideoFeederConfig = z.infer<typeof VideoFeederConfigSchema>;

// ---------------------------------------------------------------------------
// Teardown — the structured intelligence extracted per clip (the novel
// artifact). Produced by the teardown specialist panel and stored as
// noelle.video_teardowns. Don't trust the caption alone: every field is grounded
// in the transcript (faster-whisper) + the clip itself (Vertex Gemini
// native-video) + optional shot/OCR (GCP Video Intelligence).
// ---------------------------------------------------------------------------
export const VideoHookTypeSchema = z.enum([
  "question",
  "bold_claim",
  "pattern_interrupt",
  "story_open",
  "stat",
  "callout",
  "tease",
  "other",
]);
export type VideoHookType = z.infer<typeof VideoHookTypeSchema>;

export const VideoHookSchema = z.object({
  /** The hook line (spoken and/or on-screen) in the first ~3s. */
  text: z.string(),
  type: VideoHookTypeSchema,
  /** Why it stops the scroll. */
  reason: z.string().optional(),
});
export type VideoHook = z.infer<typeof VideoHookSchema>;

export const VideoBeatSchema = z.object({
  tStart: z.number().nonnegative(),
  tEnd: z.number().nonnegative(),
  /** What this segment does ("setup", "proof", "twist", "payoff", ...). */
  purpose: z.string(),
  /** Transcript / on-screen text for this beat. */
  text: z.string().optional(),
});
export type VideoBeat = z.infer<typeof VideoBeatSchema>;

export const VideoTransitionTypeSchema = z.enum([
  "cut",
  "jump_cut",
  "match_cut",
  "whip_pan",
  "zoom",
  "crossfade",
  "slide",
  "speed_ramp",
  "other",
]);
export type VideoTransitionType = z.infer<typeof VideoTransitionTypeSchema>;

export const VideoTransitionSchema = z.object({
  /** Seconds into the clip where the transition happens. */
  t: z.number().nonnegative(),
  type: VideoTransitionTypeSchema,
});
export type VideoTransition = z.infer<typeof VideoTransitionSchema>;

export const VideoOnscreenKindSchema = z.enum([
  "caption",
  "title",
  "kinetic_text",
  "graphic",
  "chart",
  "lower_third",
  "emoji",
  "other",
]);
export type VideoOnscreenKind = z.infer<typeof VideoOnscreenKindSchema>;

export const VideoOnscreenSchema = z.object({
  t: z.number().nonnegative(),
  kind: VideoOnscreenKindSchema.default("caption"),
  text: z.string().optional(),
  /** Visual style notes (font energy, placement, color, animation). */
  style: z.string().optional(),
});
export type VideoOnscreen = z.infer<typeof VideoOnscreenSchema>;

export const VideoPacingSchema = z.object({
  cutsPerSec: z.number().nonnegative(),
  avgBeatSec: z.number().nonnegative(),
  wordsPerSec: z.number().nonnegative(),
});
export type VideoPacing = z.infer<typeof VideoPacingSchema>;

export const VideoCtaSchema = z.object({
  present: z.boolean(),
  text: z.string().optional(),
  placement: z.enum(["start", "mid", "end", "none"]).default("none"),
});
export type VideoCta = z.infer<typeof VideoCtaSchema>;

export const VideoSoundSchema = z.object({
  musicId: z.string().optional(),
  trackName: z.string().optional(),
  energy: z.enum(["low", "medium", "high"]).optional(),
  /** Is this a trending audio at pull time? */
  trending: z.boolean().optional(),
  /** Are cuts synced to the beat? */
  beatSynced: z.boolean().optional(),
});
export type VideoSound = z.infer<typeof VideoSoundSchema>;

// The canonical teardown record (Synthesist output, Auditor-verified).
export const VideoTeardownSchema = z.object({
  hook: VideoHookSchema,
  beats: z.array(VideoBeatSchema).default([]),
  transitions: z.array(VideoTransitionSchema).default([]),
  onscreen: z.array(VideoOnscreenSchema).default([]),
  pacing: VideoPacingSchema,
  cta: VideoCtaSchema,
  sound: VideoSoundSchema,
  /** Grounded hypothesis for why this clip retained + performed. */
  whyItWorked: z.string(),
  /** Full timestamped transcript (faster-whisper). */
  transcript: z.string().optional(),
});
export type VideoTeardown = z.infer<typeof VideoTeardownSchema>;

// ---------------------------------------------------------------------------
// Ultra profile — the distilled Video Brand Guide (Curator output), aggregated
// per creator / per niche / "my account". Stored as the jsonb distillation on
// noelle.video_ultra_profiles (alongside scalar avg-metric columns).
// ---------------------------------------------------------------------------
export const VideoStructureTemplateSchema = z.object({
  name: z.string(),
  beats: z.array(z.string()),
  /** The actual hook line of the best-performing clip with this structure. */
  example: z.string().optional(),
  /** Views of that example clip (so the UI can show what this structure pulls). */
  views: z.number().optional(),
});
export type VideoStructureTemplate = z.infer<typeof VideoStructureTemplateSchema>;

export const VideoUltraProfileSchema = z.object({
  /**
   * Recurring hook moves, strongest-first. Each carries a representative line,
   * why it stops the scroll, and the views of the clip it came from — so the
   * Brand Guide can show a concrete example, not just the hook category.
   */
  hookLibrary: z
    .array(
      z.object({
        type: VideoHookTypeSchema,
        example: z.string(),
        /** Why this hook stops the scroll (from the clip's teardown). */
        reason: z.string().optional(),
        /** Views of the clip this example came from. */
        views: z.number().optional(),
      }),
    )
    .default([]),
  /** The transition moves this creator/niche reaches for. */
  transitionVocabulary: z.array(VideoTransitionTypeSchema).default([]),
  /** Typical pacing fingerprint (any subset of the pacing fields). */
  pacingFingerprint: VideoPacingSchema.partial().optional(),
  /** Reusable structure templates distilled from the corpus. */
  structureTemplates: z.array(VideoStructureTemplateSchema).default([]),
  /** Sound/music patterns (trending-audio reliance, energy bands, beat-sync). */
  soundPatterns: z.array(z.string()).default([]),
  /** Real CTA lines pulled from top clips (strongest-first), e.g. "follow for part 2". */
  ctaExamples: z.array(z.string()).default([]),
  /** Prose: what consistently performs for this creator/niche/account. */
  whatPerforms: z.string().optional(),
});
export type VideoUltraProfile = z.infer<typeof VideoUltraProfileSchema>;

// ---------------------------------------------------------------------------
// Studio output status enums (mirror posts.ts). The generated idea/draft wire
// shapes land with the studio's api-vm routes in a later phase.
// ---------------------------------------------------------------------------
export const VideoIdeaStatusSchema = z.enum([
  "proposed",
  "approved",
  "drafting",
  "drafted",
  "ready",
  "published",
  "dismissed",
]);
export type VideoIdeaStatus = z.infer<typeof VideoIdeaStatusSchema>;

export const VideoDraftStatusSchema = z.enum([
  "draft",
  "ready",
  "published",
  "dismissed",
]);
export type VideoDraftStatus = z.infer<typeof VideoDraftStatusSchema>;

// ── Studio generation (W4): ideas + drafts ────────────────────────────────
// The "Generate ideas" / weekly-batch trigger, stored in
// agent_instances.video_ideation_request (NULL = no pending run).
export const VideoIdeationRequestSchema = z
  .object({
    mode: z.enum(["single", "batch"]).default("single"),
    count: z.number().int().min(1).max(10).default(5),
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    requestedAt: z.string().optional(),
  })
  .strict();
export type VideoIdeationRequest = z.infer<typeof VideoIdeationRequestSchema>;

// One generated idea card (the ideator output → noelle.video_ideas).
export const VideoIdeaInSchema = z.object({
  hook: z.string().min(1).max(600),
  concept: z.string().max(1200).nullable().optional(),
  angle: z.string().max(60).nullable().optional(),
  pillar: z.string().max(120).nullable().optional(),
  inspirationClipIds: z.array(z.string()).max(12).default([]),
  suggestedDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
export type VideoIdeaIn = z.infer<typeof VideoIdeaInSchema>;

export const VideoIdeasOutSchema = z.object({ ideas: z.array(VideoIdeaInSchema).max(10) });
export type VideoIdeasOut = z.infer<typeof VideoIdeasOutSchema>;

// Operator-authored idea (the studio "write your own").
export const ManualVideoIdeaInSchema = z.object({
  hook: z.string().min(1).max(3000),
  concept: z.string().max(1200).nullable().optional(),
  suggestedDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
export type ManualVideoIdeaIn = z.infer<typeof ManualVideoIdeaInSchema>;

// The scripter's structured output (→ noelle.video_drafts).
export const VideoStructureBeatSchema = z.object({
  tStart: z.number().nonnegative(),
  tEnd: z.number().nonnegative(),
  purpose: z.string(),
  line: z.string(),
});
export type VideoStructureBeat = z.infer<typeof VideoStructureBeatSchema>;

export const VideoSoundSuggestionSchema = z.object({
  name: z.string(),
  reason: z.string().optional(),
  trending: z.boolean().optional(),
});
export const VideoTransitionSuggestionSchema = z.object({
  at: z.string(),
  type: VideoTransitionTypeSchema,
});
export const VideoGraphSpecSchema = z.object({
  kind: z.enum(["bar", "line", "time_series", "stat", "lower_third", "kinetic_text", "other"]),
  title: z.string().optional(),
  data: z.unknown().optional(),
  note: z.string().optional(),
  /** The second this overlay appears on screen — places it on its beat in the storyboard. */
  tStart: z.number().nonnegative().optional(),
});

export const VideoScriptOutputSchema = z.object({
  hook: z.string(),
  structure: z.array(VideoStructureBeatSchema).default([]),
  script: z.string(),
  transitions: z.array(VideoTransitionSuggestionSchema).default([]),
  sounds: z.array(VideoSoundSuggestionSchema).default([]),
  graphSpecs: z.array(VideoGraphSpecSchema).default([]),
});
export type VideoScriptOutput = z.infer<typeof VideoScriptOutputSchema>;

// ── Recording brief (W6 "briefer"): the media-intern prep artifact ─────────
// A phone-readable brief Nova generates for an operator-APPROVED draft (status
// 'ready'), realizing the never-deployed Paperclip media-intern capability
// inside the live Nova pipeline. The LLM returns this STRUCTURED shape via the
// JsonFn seam; a deterministic renderer builds the markdown and counts the Forge
// follow-ups (never an LLM-authored integer). See brief-generate.ts.

/** One timed shot in the shot list ("0-3s: open on the laptop, medium shot"). */
export const RecordingShotSchema = z.object({
  tStart: z.number().nonnegative(),
  tEnd: z.number().nonnegative(),
  description: z.string(),
});
export type RecordingShot = z.infer<typeof RecordingShotSchema>;

/**
 * One on-the-day note. `forgeWouldHelp` flags a note where a Forge asset (an
 * overlay, a generated image, a chart) would strengthen the shot — the flags are
 * summed into `forge_followups` deterministically by the tick (NOT by the model),
 * the forward hook a later Forge skill consumes. This spec ships the signal only.
 */
export const OnTheDayNoteSchema = z.object({
  note: z.string(),
  forgeWouldHelp: z.boolean().default(false),
});
export type OnTheDayNote = z.infer<typeof OnTheDayNoteSchema>;


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

/** Props/setting split into what MUST be in frame and what must NOT (the
 *  founder-journey positioning rule: keep off-brand signals out of shot). */
export const RecordingPropsSchema = z.object({
  inFrame: z.array(z.string()).default([]),
  mustNotBeInFrame: z.array(z.string()).default([]),
});
export type RecordingProps = z.infer<typeof RecordingPropsSchema>;

/**
 * The briefer's structured output (→ noelle.video_recording_briefs.brief). Keeps
 * the Paperclip media-intern's full section set: hook check, shot list, b-roll,
 * cam angles, props/setting, runtime target, and on-the-day notes.
 */
export const RecordingBriefOutputSchema = z.object({
  /** Working title for the recording session (usually the draft's hook, tightened). */
  title: z.string(),
  /** Target runtime in SECONDS. */
  runtimeTarget: z.number().nonnegative(),
  /** Does the hook land in the first ~3s? A one-line go/no-go check for the operator. */
  hookCheck: z.string(),
  /** Ordered, timed shot list. */
  shotList: z.array(RecordingShotSchema).default([]),
  /** Supplementary b-roll to grab. */
  bRoll: z.array(z.string()).default([]),
  /** Camera angles / framing to use. */
  camAngles: z.array(z.string()).default([]),
  /** Props + setting: what belongs in frame, what must be kept out. */
  props: RecordingPropsSchema.default({ inFrame: [], mustNotBeInFrame: [] }),
  /** Reminders for filming day; flagged items roll up into forge_followups. */
  onTheDayNotes: z.array(OnTheDayNoteSchema).default([]),
});
export type RecordingBriefOutput = z.infer<typeof RecordingBriefOutputSchema>;

// --- Phase 4: asset generation (W5, "assist + overlays") -------------------
// Typed Remotion overlay specs — the render target for video_drafts.graph_specs.
// A discriminated union so the Build panel + the Forge/Remotion renderer know
// exactly which vertical (1080x1920) composition + params to use. The scripter
// emits the looser VideoGraphSpec; `remotionAssetFromGraphSpec` coerces it.
export const BarChartSpecSchema = z.object({
  kind: z.literal("bar_chart"),
  title: z.string().optional(),
  points: z.array(z.object({ label: z.string(), value: z.number() })).min(1),
  brandColor: z.string().optional(),
  durationFrames: z.number().int().positive().default(180),
});
export const LineChartSpecSchema = z.object({
  kind: z.literal("line_chart"),
  title: z.string().optional(),
  series: z.array(z.object({ x: z.union([z.string(), z.number()]), y: z.number() })).min(2),
  brandColor: z.string().optional(),
  durationFrames: z.number().int().positive().default(180),
});
export const KineticCaptionSpecSchema = z.object({
  kind: z.literal("kinetic_caption"),
  lines: z.array(z.string()).min(1),
  brandColor: z.string().optional(),
  durationFrames: z.number().int().positive().default(120),
});
export const LowerThirdSpecSchema = z.object({
  kind: z.literal("lower_third"),
  title: z.string(),
  subtitle: z.string().optional(),
  brandColor: z.string().optional(),
  durationFrames: z.number().int().positive().default(120),
});
export const RemotionAssetSpecSchema = z.discriminatedUnion("kind", [
  BarChartSpecSchema,
  LineChartSpecSchema,
  KineticCaptionSpecSchema,
  LowerThirdSpecSchema,
]);
export type RemotionAssetSpec = z.infer<typeof RemotionAssetSpecSchema>;

export const ImageGenSpecSchema = z.object({
  prompt: z.string().min(1),
  aspect: z.enum(["9:16", "1:1", "16:9"]).default("9:16"),
  style: z.string().optional(),
});
export type ImageGenSpec = z.infer<typeof ImageGenSpecSchema>;

// A rendered/generated asset persisted on video_drafts.assets (mig 0070).
export const VideoDraftAssetSchema = z.object({
  kind: z.enum(["overlay", "image"]),
  url: z.string(), // mp4/png URL or a data: URL
  label: z.string().optional(),
  specKind: z.string().optional(), // the RemotionAssetSpec.kind it came from
  createdAt: z.string(),
});
export type VideoDraftAsset = z.infer<typeof VideoDraftAssetSchema>;

/**
 * Coerce the scripter's loose VideoGraphSpec into a typed RemotionAssetSpec for
 * rendering. Maps the loose `kind` + best-effort reads `data`. Returns null when
 * the spec can't be rendered (the Build panel just shows it as a suggestion).
 */
export function remotionAssetFromGraphSpec(spec: unknown): RemotionAssetSpec | null {
  if (!spec || typeof spec !== "object") return null;
  const g = spec as { kind?: string; title?: string; data?: unknown; note?: string };
  const title = typeof g.title === "string" ? g.title : undefined;
  const dataArr = Array.isArray(g.data) ? (g.data as unknown[]) : [];
  const num = (v: unknown): number | null => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  };
  if (g.kind === "bar" || g.kind === "line" || g.kind === "time_series") {
    const points = dataArr
      .map((d) => {
        const o = (d ?? {}) as Record<string, unknown>;
        const value = num(o.value ?? o.y ?? o.count);
        const label = String(o.label ?? o.x ?? o.name ?? "");
        return value !== null && label ? { label, value } : null;
      })
      .filter((p): p is { label: string; value: number } => p !== null);
    if (points.length === 0) return null;
    if (g.kind === "bar") return { kind: "bar_chart", title, points, durationFrames: 180 };
    return { kind: "line_chart", title, series: points.map((p) => ({ x: p.label, y: p.value })), durationFrames: 180 };
  }
  if (g.kind === "kinetic_text") {
    // `title` carries the on-screen words; `note` is the animation direction, so
    // it must NOT become a caption line. Split a multi-line title into lines.
    const lines = (title ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.length ? { kind: "kinetic_caption", lines, durationFrames: 120 } : null;
  }
  if (g.kind === "lower_third" && title) {
    return { kind: "lower_third", title, subtitle: typeof g.note === "string" ? g.note : undefined, durationFrames: 120 };
  }
  return null;
}

/**
 * A script edit Nova (the video refiner) proposes when the operator asks it to
 * change the draft on screen. Same propose-then-confirm contract as the
 * targeting/vault blocks: the chat LLM emits a fenced ```noelle-script-edit
 * block of this JSON, the route extracts + validates it, and it only touches the
 * draft when the operator clicks Apply — which loads the new lines into the
 * studio editor (marked dirty) for review before Save. The LLM never writes.
 */
export const ScriptEditProposalSchema = z.object({
  /** Per-beat voice-line replacements, keyed by the beat's 0-based storyboard index. */
  beats: z
    .array(
      z.object({
        index: z.number().int().min(0).max(50),
        line: z.string().min(1).max(2000),
      }),
    )
    .max(50)
    .optional(),
  /** A full-script replacement (when the operator asked for a whole-pass rewrite). */
  fullScript: z.string().min(1).max(20_000).optional(),
  /** One-line human summary of the change, shown on the Apply card. */
  summary: z.string().min(1).max(300),
});
export type ScriptEditProposal = z.infer<typeof ScriptEditProposalSchema>;

// ---------------------------------------------------------------------------
// Harvest run summary — the inspectable, live record of one Scout harvest run,
// written incrementally into noelle.worker_runs.summary as the tick works
// through each lane. Powers the harvest console: per-lane pulled→kept counts,
// *why* clips were dropped, hard errors, live phase/progress, and cancellation.
// Every lane the worker touches appends/updates one entry so the operator can
// watch a run fill in (~3s polling) and tell a too-strict filter (kept:0,
// dropped.belowMinViews:30) apart from a bad pull (pulled:0, error set).
// ---------------------------------------------------------------------------
/** Why clips fell out of a lane before upsert. All counts, never PII. */
export const HarvestDropReasonsSchema = z
  .object({
    /** Niche lane: below nicheTrending.minViews floor. */
    belowMinViews: z.number().int().min(0).default(0),
    /** Not selected by any creator lane (top-by-views/engagement/outperformer). */
    notSelected: z.number().int().min(0).default(0),
    /** Objective grader judged off-objective (only when grading ran). */
    offObjective: z.number().int().min(0).default(0),
  })
  .strict();
export type HarvestDropReasons = z.infer<typeof HarvestDropReasonsSchema>;

export const HarvestLaneKindSchema = z.enum(["creator", "niche"]);

/** One creator or niche lane's outcome within a run. */
export const HarvestLaneResultSchema = z
  .object({
    kind: HarvestLaneKindSchema,
    /** "@handle" for creators, the query for niches. */
    label: z.string().max(200),
    /** Raw clips the actor returned for this lane. */
    pulled: z.number().int().min(0).default(0),
    /** Clips that passed the W1 filters (before objective grading). */
    selected: z.number().int().min(0).default(0),
    /** Clips actually upserted (after grading, if any). */
    kept: z.number().int().min(0).default(0),
    dropped: HarvestDropReasonsSchema.default({}),
    /** True when the objective grader ran on this lane. */
    graded: z.boolean().default(false),
    /** Set when this lane's pull failed (apify abort/quota/timeout). */
    error: z.string().max(500).optional(),
  })
  .strict();
export type HarvestLaneResult = z.infer<typeof HarvestLaneResultSchema>;


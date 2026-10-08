import type { VideoUltraProfile } from "@noelle/contracts";
import { paceLabel } from "./distill.js";

// PURE renderer: turn one distilled Video Brand Guide (a VideoUltraProfile) into
// a self-contained SKILL.md the operator (or a downstream skill runner) can read
// when scripting a short. No IO, no clock — every value comes from the caller,
// and `refreshedAtISO` is the DB row's timestamp, NOT `now()`. This keeps the
// output deterministic for a given row so re-emitting is a no-op diff.

export interface SkillRenderInput {
  /** "instagram" | "tiktok" (kept as string — the renderer only prints it). */
  platform: string;
  /** "creator" | "niche" | "account" (kept as string — only printed). */
  scope: string;
  /** Creator handle, niche query, or "me" for the operator's own account. */
  subject: string;
  /** The parsed, schema-valid Brand Guide distillation. */
  profile: VideoUltraProfile;
  avgViews: number | null;
  clipsAnalyzed: number;
  /** ISO-8601, taken from the video_ultra_profiles row (refreshed_at), never now(). */
  refreshedAtISO: string;
}

/** Filesystem-safe slug for one profile: platform-scope-subject, `[a-z0-9-]+`. */
export function skillSlug(platform: string, scope: string, subject: string): string {
  const part = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const joined = [part(platform), part(scope), part(subject)].filter(Boolean).join("-");
  return joined || "video-pattern";
}

// --- small formatting helpers (all pure) -----------------------------------

/** First sentence of a blob — a period/!/? followed by whitespace or end. Skips
 *  in-word dots like "0.16" (the dot there isn't followed by whitespace). */
function firstSentence(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^([\s\S]*?[.!?])(?=\s|$)/);
  return m?.[1] ?? trimmed;
}

/** A safe single-line YAML double-quoted scalar (no colons/newlines break it). */
function yamlScalar(s: string): string {
  return `"${s.replace(/\r?\n/g, " ").replace(/"/g, "'").trim()}"`;
}

/** Escape a value for a Markdown table cell (pipes + newlines would break it). */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function renderHooks(hooks: VideoUltraProfile["hookLibrary"]): string {
  if (hooks.length === 0) return "_No hooks recorded yet._";
  const head = "| Type | Example line | Why it stops the scroll | Views |\n| --- | --- | --- | --- |";
  const rows = hooks.map((h) => {
    const type = cell(h.type.replace(/_/g, " "));
    const example = cell(h.example) || "—";
    const reason = cell(h.reason ?? "") || "—";
    const views = h.views !== undefined ? String(h.views) : "—";
    return `| ${type} | ${example} | ${reason} | ${views} |`;
  });
  return [head, ...rows].join("\n");
}

function renderTemplates(templates: VideoUltraProfile["structureTemplates"]): string {
  if (templates.length === 0) return "_No structure templates yet._";
  return templates
    .map((t) => {
      const beats = t.beats.length ? t.beats.join(" → ") : "—";
      const example = t.example?.trim() ? `"${cell(t.example)}"` : "—";
      const views = t.views !== undefined ? `${t.views} views` : "—";
      return `- **${cell(t.name)}** — ${beats} — ${example} — ${views}`;
    })
    .join("\n");
}

function renderPacing(p: VideoUltraProfile["pacingFingerprint"]): string {
  if (!p) return "_No pacing data yet._";
  const parts: string[] = [];
  if (p.cutsPerSec !== undefined) parts.push(`${p.cutsPerSec.toFixed(2)} cuts/s`);
  if (p.avgBeatSec !== undefined) parts.push(`${p.avgBeatSec.toFixed(2)}s per beat`);
  if (p.wordsPerSec !== undefined) parts.push(`${p.wordsPerSec.toFixed(2)} words/s`);
  const metrics = parts.length ? parts.join(" · ") : "no metrics recorded";
  const label = p.cutsPerSec !== undefined ? paceLabel(p.cutsPerSec) : null;
  return label ? `**${label}** — ${metrics}` : metrics;
}

function renderList(items: string[], empty: string): string {
  const clean = items.map((s) => s.trim()).filter(Boolean);
  if (clean.length === 0) return empty;
  return clean.map((s) => `- ${s}`).join("\n");
}

/** Render one profile to `{ slug, markdown }`. Tolerates empty arrays + missing
 *  optional scalars — a barely-distilled guide still produces a valid SKILL.md. */
export function renderSkillMarkdown(input: SkillRenderInput): { slug: string; markdown: string } {
  const { platform, scope, subject, profile, avgViews, clipsAnalyzed, refreshedAtISO } = input;
  const slug = skillSlug(platform, scope, subject);

  const whatPerforms = (profile.whatPerforms ?? "").trim();
  const firstS = whatPerforms ? firstSentence(whatPerforms) : "";
  const description =
    `Viral video pattern distilled from ${subject} on ${platform}` +
    `${firstS ? ` — ${firstS}` : ""}. Use when scripting a ${platform} short.`;

  const transitions = profile.transitionVocabulary.map((t) => t.replace(/_/g, " "));

  const md = [
    "---",
    `name: ${slug}`,
    `description: ${yamlScalar(description)}`,
    "---",
    "",
    `# ${subject} — ${platform} viral pattern (${scope})`,
    "",
    "## What performs",
    whatPerforms || "_No distilled summary yet._",
    "",
    "## Hook library",
    renderHooks(profile.hookLibrary),
    "",
    "## Structure templates",
    renderTemplates(profile.structureTemplates),
    "",
    "## Pacing fingerprint",
    renderPacing(profile.pacingFingerprint),
    "",
    "## Transition vocabulary",
    transitions.length ? transitions.join(", ") : "_None recorded._",
    "",
    "## Sound patterns",
    renderList(profile.soundPatterns, "_None recorded._"),
    "",
    "## CTA examples",
    renderList(profile.ctaExamples, "_None recorded._"),
    "",
    "---",
    `_Scope: ${scope} · Subject: ${subject} · Platform: ${platform} · ` +
      `Clips analyzed: ${clipsAnalyzed} · Avg views: ${avgViews === null ? "unknown" : Math.round(avgViews)} · ` +
      `Refreshed: ${refreshedAtISO || "unknown"}_`,
    "",
  ].join("\n");

  return { slug, markdown: md };
}

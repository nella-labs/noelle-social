import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Sql } from "postgres";
import { loadAccountUltraProfile, type AccountUltraProfile } from "./ultra-profiles-db.js";
import { summarizeSelfMetrics, type SelfMetricsSummary } from "./self-tracking-db.js";
import { loadBrandContext, type VaultKb } from "./vault-grounding.js";

// The operator's "personal brand state": a single markdown artifact distilled from
// (1) their objective, (2) their vault brand/voice docs, (3) the account
// ultra-profile of what their OWN content performs, and (4) their self-tracked
// numbers. The distiller regenerates it after each account distillation and drops
// it in the vault so the scripter can PREFER it ahead of raw BM25 anchors — a
// stable, curated "who I am + what works for me" the drafter always leads with.
//
// composePersonalBrandState is PURE (no fs / sql / clock in its body; generatedAt
// is supplied) so it's trivially unit-testable and deterministic. The fs + sql
// live in the thin wrappers below.

/** The do-not-fake guardrails, lifted verbatim from the vault brand template
 *  (packages/runtime/src/vault-template/02-brand/brand.md → "## Boundaries"). */
const DEFAULT_BOUNDARIES = [
  "Do not fake scale, revenue, team size, or usage.",
  "Do not invent customers.",
  "Do not turn vulnerability into trauma bait.",
  "Do not turn every post into a product pitch.",
];

export interface PersonalBrandStateInput {
  /** Frontmatter timestamp — passed in so the composer stays pure/deterministic. */
  generatedAt: Date;
  /** instance.objective → "## Mission". Null/blank omits the section. */
  objective: string | null;
  /** Vault brand/voice snippets → "## How I sound". Empty omits the section. */
  brandDocs: readonly string[];
  /** The operator's own-account Brand Guide → "## What performs for me". Null omits it. */
  accountProfile: AccountUltraProfile | null;
  /** Rolled-up self-tracking numbers → "## My numbers". Null omits the section. */
  selfMetrics: SelfMetricsSummary | null;
  /** Override the do-not-fake list; defaults to the vault template's boundaries. */
  boundaries?: readonly string[];
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

function renderMission(objective: string | null): string | null {
  const o = (objective ?? "").trim();
  if (!o) return null;
  return `## Mission\n\n${o}`;
}

function renderHowISound(brandDocs: readonly string[]): string | null {
  const docs = brandDocs.map(collapse).filter(Boolean);
  if (docs.length === 0) return null;
  return ["## How I sound", "", ...docs.map((d) => `- ${d}`)].join("\n");
}

function renderWhatPerforms(account: AccountUltraProfile | null): string | null {
  if (!account) return null;
  const p = account.profile;
  const lines: string[] = ["## What performs for me", ""];

  const what = (p.whatPerforms ?? "").trim();
  if (what) lines.push(what, "");

  const hooks = p.hookLibrary
    .filter((h) => h.example.trim())
    .map((h) => {
      const reason = h.reason?.trim();
      return `- ${h.type.replace(/_/g, " ")}: "${collapse(h.example)}"${reason ? ` — ${collapse(reason)}` : ""}`;
    });
  if (hooks.length) lines.push("Hooks that work for me:", ...hooks, "");

  const structures = p.structureTemplates
    .filter((t) => t.beats.length)
    .map((t) => `- ${t.name}: ${t.beats.join(" > ")}`);
  if (structures.length) lines.push("Structures that work:", ...structures, "");

  const ctas = p.ctaExamples.map(collapse).filter(Boolean).map((c) => `- "${c}"`);
  if (ctas.length) lines.push("CTAs that work:", ...ctas, "");

  const pace = p.pacingFingerprint;
  if (pace) {
    const parts: string[] = [];
    if (pace.cutsPerSec !== undefined) parts.push(`${pace.cutsPerSec.toFixed(2)} cuts/s`);
    if (pace.avgBeatSec !== undefined) parts.push(`~${pace.avgBeatSec.toFixed(1)}s/beat`);
    if (pace.wordsPerSec !== undefined) parts.push(`${pace.wordsPerSec.toFixed(1)} words/s`);
    if (parts.length) lines.push(`Pacing: ${parts.join(", ")}.`);
  }

  // Trim a trailing blank line for tidy output.
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function renderNumbers(m: SelfMetricsSummary | null): string | null {
  if (!m) return null;
  const round = (n: number | null): string => n === null ? "unknown" : String(Math.round(n));
  const lines: string[] = ["## My numbers", ""];
  lines.push(`- Tracked own clips: ${m.clips}`);
  lines.push(`- Avg views: ${round(m.avgViews)}`);
  lines.push(`- Avg likes: ${round(m.avgLikes)}`);
  lines.push(`- Avg comments: ${round(m.avgComments)}`);
  if (m.avgShares !== null && m.avgShares > 0) lines.push(`- Avg shares: ${round(m.avgShares)}`);
  if (m.avgSaves !== null && m.avgSaves > 0) lines.push(`- Avg saves: ${round(m.avgSaves)}`);
  const identity = m.followerHandle && m.followerPlatform ? ` (@${m.followerHandle} · ${m.followerPlatform})` : "";
  if (m.followerCount !== null) lines.push(`- Followers: ${m.followerCount}${identity}`);
  if (m.followerDelta !== null) {
    const sign = m.followerDelta >= 0 ? "+" : "";
    lines.push(`- Follower change (tracked window): ${sign}${m.followerDelta}`);
  }
  return lines.join("\n");
}

function renderBoundaries(boundaries: readonly string[]): string {
  return ["## Boundaries", "", ...boundaries.map((b) => `- ${b}`)].join("\n");
}

/**
 * PURE. Compose the personal-brand-state.md markdown from the gathered inputs. Any
 * missing input omits its section (never throws); the frontmatter, title, and the
 * do-not-fake Boundaries are always present, so the output is always valid markdown.
 */
export function composePersonalBrandState(input: PersonalBrandStateInput): string {
  const frontmatter = [
    "---",
    "type: personal-brand-state",
    "status: generated",
    `generated_at: ${input.generatedAt.toISOString()}`,
    "---",
  ].join("\n");

  const blocks: Array<string | null> = [
    frontmatter,
    "# Personal brand state",
    renderMission(input.objective),
    renderHowISound(input.brandDocs),
    renderWhatPerforms(input.accountProfile),
    renderNumbers(input.selfMetrics),
    renderBoundaries(input.boundaries ?? DEFAULT_BOUNDARIES),
  ];

  return blocks.filter((b): b is string => b !== null).join("\n\n") + "\n";
}

export interface BuildPersonalBrandStateDeps {
  sql: Sql;
  instanceId: string;
  objective: string | null;
  /** Vault KB for the brand/voice snippets (null → no "How I sound" body). */
  kb: VaultKb | null;
  /** Frontmatter timestamp (usually `new Date()` at the call site). */
  generatedAt: Date;
  /** Query for the brand-doc retrieval; defaults to the objective / generic probe. */
  brandQuery?: string | null;
}

/**
 * Orchestrator: pull the three sources (account ultra-profile, self metrics, vault
 * brand snippets) and compose the artifact. Each source fails open to
 * null/[] so a partial artifact still generates. Returns the markdown string; the
 * caller persists it via writePersonalBrandState.
 */
export async function buildPersonalBrandState(deps: BuildPersonalBrandStateDeps): Promise<string> {
  const [accountProfile, selfMetrics, brandDocs] = await Promise.all([
    loadAccountUltraProfile(deps.sql, deps.instanceId).catch(() => null),
    summarizeSelfMetrics(deps.sql, deps.instanceId).catch(() => null),
    loadBrandContext(deps.kb, deps.brandQuery ?? deps.objective, 6),
  ]);
  return composePersonalBrandState({
    generatedAt: deps.generatedAt,
    objective: deps.objective,
    brandDocs,
    accountProfile,
    selfMetrics,
  });
}

/**
 * Write the artifact to `absPath`, creating parent dirs. Fully fail-open: a write
 * error is swallowed so generation can never block the distiller tick.
 */
export async function writePersonalBrandState(absPath: string, md: string): Promise<void> {
  try {
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, md, "utf8");
  } catch {
    // fail-open: persistence is best-effort; never throw into the caller.
  }
}

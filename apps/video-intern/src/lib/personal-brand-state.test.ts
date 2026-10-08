import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePersonalBrandState } from "./personal-brand-state.js";
import type { AccountUltraProfile } from "./ultra-profiles-db.js";
import type { SelfMetricsSummary } from "./self-tracking-db.js";
import { loadBrandContext, loadBrandContextPreferringState, type VaultKb } from "./vault-grounding.js";

const GEN_AT = new Date("2026-07-03T12:00:00.000Z");

function account(): AccountUltraProfile {
  return {
    profile: {
      hookLibrary: [
        { type: "question", example: "did you know most founders quit here?", reason: "open loop", views: 9000 },
      ],
      transitionVocabulary: ["jump_cut"],
      pacingFingerprint: { cutsPerSec: 0.16, avgBeatSec: 3, wordsPerSec: 2.4 },
      structureTemplates: [{ name: "question → end CTA", beats: ["hook", "payoff"], example: "did you know...", views: 9000 }],
      soundPatterns: ["trending audio"],
      ctaExamples: ["follow for part 2"],
      whatPerforms: "Winners open on a question hook then move to a mid CTA.",
    },
    avgViews: 4200,
    avgLikes: 310,
    avgComments: 12,
    clipsAnalyzed: 8,
  };
}

function metrics(): SelfMetricsSummary {
  return {
    clips: 12,
    avgViews: 4200.4,
    avgLikes: 310.6,
    avgComments: 12.2,
    avgShares: 5,
    avgSaves: 8,
    followerCount: 1500,
    followerDelta: 120,
  };
}

describe("composePersonalBrandState", () => {
  it("labels the selected follower identity without inventing a delta", () => {
    const md = composePersonalBrandState({ generatedAt: GEN_AT, objective: null, brandDocs: [], accountProfile: null,
      selfMetrics: { ...metrics(), followerCount: 0, followerDelta: null, followerHandle: "primary", followerPlatform: "tiktok" } });
    expect(md).toContain("Followers: 0 (@primary · tiktok)");
    expect(md).not.toContain("Follower change");
  });
  it("labels unmeasured averages unknown and retains measured zero", () => {
    const md = composePersonalBrandState({ generatedAt: GEN_AT, objective: null, brandDocs: [], accountProfile: null,
      selfMetrics: { ...metrics(), avgViews: null, avgLikes: 0, avgComments: null, avgShares: null, avgSaves: null } });
    expect(md).toContain("Avg views: unknown");
    expect(md).toContain("Avg likes: 0");
    expect(md).toContain("Avg comments: unknown");
    expect(md).not.toContain("Avg shares: 0");
  });
  it("renders every section from a full fixture", () => {
    const md = composePersonalBrandState({
      generatedAt: GEN_AT,
      objective: "Grow my account with builder-first short-form video",
      brandDocs: ["I write plainly, builder-first, never marketer-first."],
      accountProfile: account(),
      selfMetrics: metrics(),
    });

    // Frontmatter + title.
    expect(md.startsWith("---\ntype: personal-brand-state\n")).toBe(true);
    expect(md).toContain("status: generated");
    expect(md).toContain("generated_at: 2026-07-03T12:00:00.000Z");
    expect(md).toContain("# Personal brand state");

    // Each section header.
    expect(md).toContain("## Mission");
    expect(md).toContain("Grow my account with builder-first short-form video");
    expect(md).toContain("## How I sound");
    expect(md).toContain("I write plainly, builder-first, never marketer-first.");
    expect(md).toContain("## What performs for me");
    expect(md).toContain("Winners open on a question hook then move to a mid CTA.");
    expect(md).toContain('question: "did you know most founders quit here?"');
    expect(md).toContain("follow for part 2");
    expect(md).toContain("0.16 cuts/s");

    // The numbers.
    expect(md).toContain("## My numbers");
    expect(md).toContain("Tracked own clips: 12");
    expect(md).toContain("Avg views: 4200");
    expect(md).toContain("Followers: 1500");
    expect(md).toContain("Follower change (tracked window): +120");

    // Boundaries are always present (lifted from the vault brand template).
    expect(md).toContain("## Boundaries");
    expect(md).toContain("Do not fake scale, revenue, team size, or usage.");
  });

  it("omits the account section when there is no account profile, still valid md", () => {
    const md = composePersonalBrandState({
      generatedAt: GEN_AT,
      objective: "Grow",
      brandDocs: ["voice snippet"],
      accountProfile: null,
      selfMetrics: null,
    });
    expect(md.startsWith("---\ntype: personal-brand-state\n")).toBe(true);
    expect(md).toContain("# Personal brand state");
    expect(md).not.toContain("## What performs for me");
    expect(md).not.toContain("## My numbers");
    // Title, mission, how-i-sound, and boundaries survive → valid, non-empty md.
    expect(md).toContain("## Mission");
    expect(md).toContain("## Boundaries");
  });

  it("omits 'How I sound' when there are no brand docs", () => {
    const md = composePersonalBrandState({
      generatedAt: GEN_AT,
      objective: "Grow",
      brandDocs: [],
      accountProfile: null,
      selfMetrics: null,
    });
    expect(md).not.toContain("## How I sound");
    expect(md).toContain("## Boundaries");
  });

  it("omits Mission when the objective is blank", () => {
    const md = composePersonalBrandState({
      generatedAt: GEN_AT,
      objective: "   ",
      brandDocs: [],
      accountProfile: null,
      selfMetrics: null,
    });
    expect(md).not.toContain("## Mission");
    expect(md).toContain("# Personal brand state");
  });
});

const kbReturning = (snippets: string[]): VaultKb => ({
  async search() {
    return snippets.map((s) => ({ snippet: s, score: 1, highlights: [], source: { filePath: "x.md", startLine: 1, endLine: 2 } }));
  },
});

describe("loadBrandContextPreferringState", () => {
  it("puts the artifact anchors first, ahead of the BM25 hits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pbs-"));
    try {
      const statePath = join(dir, "personal-brand-state.md");
      const artifact = "---\ntype: personal-brand-state\n---\n\n# Personal brand state\n\n## Mission\n\ngrow builder-first\n\n## Boundaries\n\n- Do not fake scale";
      await writeFile(statePath, artifact, "utf8");

      const kb = kbReturning(["bm25-a", "bm25-b"]);
      const result = await loadBrandContextPreferringState(kb, "grow", statePath);

      // The BM25 hits still trail at the end, in order.
      expect(result.slice(-2)).toEqual(["bm25-a", "bm25-b"]);
      // The artifact leads: at least one leading anchor carries its content.
      expect(result.length).toBeGreaterThan(2);
      expect(result[0]).toContain("Personal brand state");
      expect(result.some((a) => a.includes("grow builder-first"))).toBe(true);
      expect(result.some((a) => a.includes("Do not fake scale"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is byte-identical to loadBrandContext when statePath is null", async () => {
    const kb = kbReturning(["a", "b"]);
    const base = await loadBrandContext(kb, "grow");
    await expect(loadBrandContextPreferringState(kb, "grow", null)).resolves.toEqual(base);
  });

  it("is byte-identical to loadBrandContext when the file is absent", async () => {
    const kb = kbReturning(["a", "b"]);
    const base = await loadBrandContext(kb, "grow");
    const absent = join(tmpdir(), "pbs-does-not-exist", "personal-brand-state.md");
    await expect(loadBrandContextPreferringState(kb, "grow", absent)).resolves.toEqual(base);
  });

  it("fails open to the base context when the read throws (statePath is a directory)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pbs-"));
    try {
      // A directory path → readFile throws EISDIR → base returned unchanged.
      const asDir = join(dir, "isdir");
      await mkdir(asDir);
      const kb = kbReturning(["a", "b"]);
      const base = await loadBrandContext(kb, "grow");
      await expect(loadBrandContextPreferringState(kb, "grow", asDir)).resolves.toEqual(base);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

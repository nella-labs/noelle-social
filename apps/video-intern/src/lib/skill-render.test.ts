import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "postgres";
import type { VideoUltraProfile } from "@noelle/contracts";
import { renderSkillMarkdown, skillSlug } from "./skill-render.js";
import { emitSkillFiles } from "./skill-emit.js";
import type { Logger } from "./logger.js";

// A realistic, schema-valid Brand Guide (shared by the render + emit tests).
const FIXTURE: VideoUltraProfile = {
  hookLibrary: [
    { type: "bold_claim", example: "I quit my job to build this", reason: "status drop", views: 90000 },
    { type: "question", example: "did you know your phone does this?", reason: "open loop", views: 42000 },
  ],
  transitionVocabulary: ["jump_cut", "zoom"],
  pacingFingerprint: { cutsPerSec: 0.16, avgBeatSec: 2.4, wordsPerSec: 3.1 },
  structureTemplates: [
    { name: "bold_claim → end CTA", beats: ["hook", "proof", "payoff"], example: "I quit my job to build this", views: 90000 },
  ],
  soundPatterns: ["trending audio", "high energy"],
  ctaExamples: ["follow for part 2", "comment WORD for the link"],
  whatPerforms:
    'Winners open on a bold claim like "I quit my job to build this", then move through 3 beats at a fast 0.16 cuts/s pace, to a end CTA ("follow for part 2"). Sound: trending audio.',
};

const SECTION_HEADERS = [
  "## What performs",
  "## Hook library",
  "## Structure templates",
  "## Pacing fingerprint",
  "## Transition vocabulary",
  "## Sound patterns",
  "## CTA examples",
];

const silentLog = { info() {}, warn() {}, error() {} } as unknown as Logger;

// Fake tagged-template `sql` that ignores its query and resolves the given rows —
// enough for loadUltraProfiles (`await sql\`...\`` then spread).
function fakeSqlReturning(rows: unknown[]): Sql {
  return (() => Promise.resolve(rows)) as unknown as Sql;
}

describe("skillSlug", () => {
  it("joins platform-scope-subject, lowercased + hyphenated", () => {
    expect(skillSlug("instagram", "creator", "mrbeast")).toBe("instagram-creator-mrbeast");
    expect(skillSlug("instagram", "account", "me")).toBe("instagram-account-me");
  });
  it("sanitizes symbols in the subject (handles, dots, @)", () => {
    expect(skillSlug("tiktok", "creator", "@Mr.Beast!")).toBe("tiktok-creator-mr-beast");
  });
  it("falls back when everything sanitizes away", () => {
    expect(skillSlug("", "", "!!!")).toBe("video-pattern");
  });
});

describe("renderSkillMarkdown", () => {
  it("prints unknown average views without rounding null into zero", () => {
    const { markdown } = renderSkillMarkdown({ platform: "instagram", scope: "creator", subject: "source", profile: FIXTURE,
      avgViews: null, clipsAnalyzed: 1, refreshedAtISO: "" } as unknown as Parameters<typeof renderSkillMarkdown>[0]);
    expect(markdown).toContain("Avg views: unknown");
  });
  it("emits every section, the winning hook, a CTA line, and frontmatter", () => {
    const { slug, markdown } = renderSkillMarkdown({
      platform: "instagram",
      scope: "creator",
      subject: "mrbeast",
      profile: FIXTURE,
      avgViews: 51234.7,
      clipsAnalyzed: 7,
      refreshedAtISO: "2026-06-01T00:00:00.000Z",
    });

    expect(slug).toBe("instagram-creator-mrbeast");
    // Frontmatter carries the slug as `name` and a `Use when…` description.
    expect(markdown).toContain("name: instagram-creator-mrbeast");
    expect(markdown).toContain("Use when scripting a instagram short.");
    // Title + every section header present.
    expect(markdown).toContain("# mrbeast — instagram viral pattern (creator)");
    for (const h of SECTION_HEADERS) expect(markdown).toContain(h);
    // The winning hook example + a real CTA line come through.
    expect(markdown).toContain("I quit my job to build this");
    expect(markdown).toContain("follow for part 2");
    // Pacing is labelled via the shared paceLabel (0.16 cuts/s → "fast").
    expect(markdown).toContain("**fast**");
    // Footer takes metrics from the input (avg views rounded, refreshed from row).
    expect(markdown).toContain("Refreshed: 2026-06-01T00:00:00.000Z");
    expect(markdown).toContain("Avg views: 51235");
  });

  it("tolerates an empty/minimally-distilled profile", () => {
    const empty: VideoUltraProfile = {
      hookLibrary: [],
      transitionVocabulary: [],
      structureTemplates: [],
      soundPatterns: [],
      ctaExamples: [],
    };
    const { markdown } = renderSkillMarkdown({
      platform: "tiktok",
      scope: "niche",
      subject: "founder stories",
      profile: empty,
      avgViews: 0,
      clipsAnalyzed: 0,
      refreshedAtISO: "",
    });
    for (const h of SECTION_HEADERS) expect(markdown).toContain(h);
    expect(markdown).toContain("_No hooks recorded yet._");
    expect(markdown).toContain("_No pacing data yet._");
    expect(markdown).toContain("Refreshed: unknown");
  });
});

describe("emitSkillFiles", () => {
  let dir = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("writes one SKILL.md per valid profile and skips invalid rows (fail-open)", async () => {
    dir = await mkdtemp(join(tmpdir(), "nova-skills-"));
    const rows = [
      {
        platform: "instagram",
        scope: "creator",
        subject: "mrbeast",
        profile: FIXTURE,
        avg_views: "51234",
        clips_analyzed: 7,
        refreshed_at: new Date("2026-06-01T00:00:00.000Z"),
      },
      {
        // Invalid shape (hookLibrary must be an array) → schema miss → skipped.
        platform: "tiktok",
        scope: "account",
        subject: "me",
        profile: { hookLibrary: "nope" },
        avg_views: null,
        clips_analyzed: 0,
        refreshed_at: null,
      },
    ];

    const { written, paths } = await emitSkillFiles({
      sql: fakeSqlReturning(rows),
      instanceId: "inst-1",
      dir,
      log: silentLog,
    });

    expect(written).toBe(1);
    expect(paths).toHaveLength(1);

    const slugs = await readdir(dir);
    expect(slugs).toEqual(["instagram-creator-mrbeast"]);

    const md = await readFile(join(dir, "instagram-creator-mrbeast", "SKILL.md"), "utf8");
    expect(md).toContain("# mrbeast — instagram viral pattern (creator)");
    expect(md).toContain("I quit my job to build this");
    expect(md).toContain("follow for part 2");
    for (const h of SECTION_HEADERS) expect(md).toContain(h);
  });
});

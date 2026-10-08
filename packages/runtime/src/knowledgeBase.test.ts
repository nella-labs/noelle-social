import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocalFsKnowledgeBase,
  knowledgeBaseFromNella,
  parseIncludeDirs,
  type KbDenseEmbedder,
} from "./knowledgeBase.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kb-"));
  await mkdir(join(dir, "content"), { recursive: true });
  await writeFile(
    join(dir, "content", "ai-safety.md"),
    "## On AI safety\nAlignment is a systems problem, not just a model problem. Guardrails compound.\n",
  );
  await writeFile(join(dir, "README.txt"), "not markdown, ignore me");
});

/** Seed two dirs that BOTH match the query, so scoping is the only filter. */
async function seedScopedDirs(): Promise<void> {
  await mkdir(join(dir, "02-brand"), { recursive: true });
  await mkdir(join(dir, "01-business"), { recursive: true });
  await writeFile(
    join(dir, "02-brand", "voice.md"),
    "## Voice\nShipping daily wins the voice and tone playbook.\n",
  );
  await writeFile(
    join(dir, "01-business", "x.md"),
    "## Business\nShipping daily wins the revenue and growth model.\n",
  );
}

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createLocalFsKnowledgeBase", () => {
  it("BM25-ranks anchors from local markdown (KbHit shape, no workspace)", async () => {
    const kb = createLocalFsKnowledgeBase({ dir, watch: false });
    const hits = await kb.search("AI safety alignment guardrails", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet.toLowerCase()).toContain("alignment");
    expect(hits[0]!.score).toBeGreaterThan(0);
    expect(hits[0]!.source.filePath).toContain("ai-safety.md");
    expect(await kb.ready()).toBe(true);
    kb.close();
  });

  it("ignores non-markdown + empty query", async () => {
    const kb = createLocalFsKnowledgeBase({ dir, watch: false });
    expect(await kb.search("   ", 5)).toEqual([]);
    const hits = await kb.search("not markdown", 5);
    expect(hits.every((h) => h.source.filePath.endsWith(".md"))).toBe(true);
    kb.close();
  });

  it("filterDirs scopes hits to a single matching dir prefix", async () => {
    await seedScopedDirs();
    const kb = createLocalFsKnowledgeBase({ dir, watch: false });

    // "02-brand" matches "02-brand/voice.md" but NOT "01-business/x.md".
    const brand = await kb.search("shipping daily wins", 8, {
      filterDirs: ["02-brand"],
    });
    expect(brand.length).toBeGreaterThan(0);
    expect(brand.every((h) => h.source.filePath.startsWith("02-brand/"))).toBe(true);
    expect(brand.some((h) => h.source.filePath.includes("01-business"))).toBe(false);

    const biz = await kb.search("shipping daily wins", 8, {
      filterDirs: ["01-business"],
    });
    expect(biz.length).toBeGreaterThan(0);
    expect(biz.every((h) => h.source.filePath.startsWith("01-business/"))).toBe(true);
    kb.close();
  });

  it("no filterDirs vs empty filterDirs both behave like an unscoped search", async () => {
    await seedScopedDirs();
    const kb = createLocalFsKnowledgeBase({ dir, watch: false });
    const base = await kb.search("shipping daily wins", 8);
    const emptyArr = await kb.search("shipping daily wins", 8, { filterDirs: [] });
    const noOpts = await kb.search("shipping daily wins", 8, {});
    const files = (hs: Awaited<ReturnType<typeof kb.search>>) =>
      hs.map((h) => h.source.filePath);
    // Both dirs match → unscoped result spans both files.
    expect(files(base)).toEqual(files(emptyArr));
    expect(files(base)).toEqual(files(noOpts));
    expect(new Set(files(base)).size).toBeGreaterThanOrEqual(2);
    kb.close();
  });

  it("ingests NEW info without restart (signature-based reindex)", async () => {
    // watch off → exercises the corpus-signature fallback path deterministically.
    const kb = createLocalFsKnowledgeBase({ dir, watch: false, cacheTtlMs: 0 });
    const before = await kb.search("kubernetes operator pattern", 5);
    expect(before.length).toBe(0);
    await writeFile(
      join(dir, "content", "k8s.md"),
      "## Operators\nThe kubernetes operator pattern encodes ops knowledge as a controller reconciling desired state.\n",
    );
    const after = await kb.search("kubernetes operator pattern", 5);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]!.source.filePath).toContain("k8s.md");
    kb.close();
  });
});

describe("createLocalFsKnowledgeBase — includeDirs scoping (voice base)", () => {
  // Bug: the drafter indexes the WHOLE vault. content/replies + content/dms embed
  // a `## Original` quote block with the verbatim external post (earnings reports,
  // leaked AI system prompts), which out-ranks the real voice docs. Scoping the
  // index to the curated voice dirs is the only thing that fixes WHICH anchor wins
  // (score normalization is a per-query constant and can't re-rank).
  it("indexes ONLY the included subdirs, so pollution is never retrievable", async () => {
    await mkdir(join(dir, "noelle-voice"), { recursive: true });
    await mkdir(join(dir, "content", "replies"), { recursive: true });
    await writeFile(
      join(dir, "noelle-voice", "bottleneck.md"),
      "## The solo founder bottleneck\nShipping daily as a one-person company; wearing too many hats; the founder is the integration layer.\n",
    );
    // Pollution that shares query terms ("shipping", "founder") and would out-rank
    // the voice doc under the flat index.
    await writeFile(
      join(dir, "content", "replies", "pollution.md"),
      "## Original\nNet Inc $27.2b, margin 36%, EBIT, Azure region, data center capacity. shipping founder founder founder.\n",
    );
    const kb = createLocalFsKnowledgeBase({
      dir,
      watch: false,
      includeDirs: ["noelle-voice"],
    });
    const hits = await kb.search("shipping founder bottleneck", 8);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.source.filePath.startsWith("noelle-voice"))).toBe(true);
    expect(hits.some((h) => h.source.filePath.includes("replies"))).toBe(false);
    kb.close();
  });

  it("supports nested include paths like content/voice-anchors", async () => {
    await mkdir(join(dir, "content", "voice-anchors"), { recursive: true });
    await writeFile(
      join(dir, "content", "voice-anchors", "ship.md"),
      "## Ship\nShip every day. Momentum compounds; the only moat is velocity.\n",
    );
    const kb = createLocalFsKnowledgeBase({
      dir,
      watch: false,
      includeDirs: ["content/voice-anchors"],
    });
    const hits = await kb.search("ship momentum velocity", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.source.filePath).toContain("voice-anchors");
    // The beforeEach-seeded content/ai-safety.md is outside the scope → excluded.
    expect(hits.every((h) => !h.source.filePath.includes("ai-safety"))).toBe(true);
    kb.close();
  });

  it("indexes the WHOLE vault when includeDirs is unset (backward compatible)", async () => {
    await writeFile(
      join(dir, "root-note.md"),
      "## Root\nThe kubernetes operator pattern reconciles desired state.\n",
    );
    const kb = createLocalFsKnowledgeBase({ dir, watch: false });
    expect((await kb.search("alignment guardrails", 5)).length).toBeGreaterThan(0);
    expect((await kb.search("kubernetes operator", 5)).length).toBeGreaterThan(0);
    kb.close();
  });

  it("warns and stays empty (fail-open caller) when includeDirs resolves to nothing", async () => {
    const kb = createLocalFsKnowledgeBase({
      dir,
      watch: false,
      includeDirs: ["does-not-exist"],
    });
    expect(await kb.search("anything at all", 5)).toEqual([]);
    kb.close();
  });
});

describe("parseIncludeDirs", () => {
  it("splits a comma-separated env value, trimming whitespace", () => {
    expect(parseIncludeDirs("noelle-voice, content/voice-anchors ,02-brand")).toEqual([
      "noelle-voice",
      "content/voice-anchors",
      "02-brand",
    ]);
  });

  it("returns [] for unset/blank so the KB indexes the whole vault", () => {
    expect(parseIncludeDirs(undefined)).toEqual([]);
    expect(parseIncludeDirs("")).toEqual([]);
    expect(parseIncludeDirs("  , ,")).toEqual([]);
  });
});


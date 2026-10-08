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

describe("knowledgeBaseFromNella adapter", () => {
  it.each(["", " ", "\t\n"])("disables blank workspace %j before any retrieval", async (workspace) => {
    const searchContext = vi.fn();
    const kb = knowledgeBaseFromNella({ searchContext }, workspace);
    expect(await kb.ready()).toBe(false);
    expect(await kb.search("voice", 8, { filterDirs: ["02-brand"] })).toEqual([]);
    expect(searchContext).not.toHaveBeenCalled();
  });

  it("maps NellaClient Hits to KbHits and fixes the workspace", async () => {
    let calledWith: { workspace?: string } = {};
    const stub = {
      async searchContext(args: { workspace: string; query: string; topK?: number }) {
        calledWith = args;
        return [
          { path: "p.md", snippet: "voice anchor", score: 4.2, filePath: "p.md", startLine: 1, endLine: 3, highlights: ["voice"] },
        ];
      },
    };
    const kb = knowledgeBaseFromNella(stub, " \tconfigured-workspace \n");
    const hits = await kb.search("query", 8);
    expect(calledWith.workspace).toBe("configured-workspace");
    expect(hits[0]!.snippet).toBe("voice anchor");
    expect(hits[0]!.source.filePath).toBe("p.md");
    expect(await kb.ready()).toBe(true);
    expect(calledWith.workspace).toBe("configured-workspace");
  });

  it("forwards filterDirs to the underlying NellaClient (and omits it when empty)", async () => {
    const calls: Array<{ filterDirs: string[] | undefined }> = [];
    const stub = {
      async searchContext(args: { workspace: string; query: string; topK?: number; filterDirs?: string[] }) {
        calls.push({ filterDirs: args.filterDirs });
        return [];
      },
    };
    const kb = knowledgeBaseFromNella(stub, "configured-workspace");
    await kb.search("q", 8, { filterDirs: ["02-brand"] });
    await kb.search("q", 8, { filterDirs: [] });
    await kb.search("q", 8);
    expect(calls[0]!.filterDirs).toEqual(["02-brand"]);
    // Empty / absent must not narrow the backend call.
    expect(calls[1]!.filterDirs).toBeUndefined();
    expect(calls[2]!.filterDirs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Hybrid dense lane (voyage-context-4 ⊕ BM25) — injected deterministic embedder
// ---------------------------------------------------------------------------

/**
 * A deterministic topic embedder: maps text to a 3-dim unit vector by keyword
 * so cosine similarities are clean (1 same-topic, 0 cross-topic). No network.
 * `safety→[1,0,0]`, `ops→[0,1,0]`, `business→[0,0,1]`, unknown→`[0,0,0]`.
 */
function topicVec(text: string): number[] {
  const t = text.toLowerCase();
  if (/(safety|alignment|corrigible|guardrail|oversight|overseeable)/.test(t)) return [1, 0, 0];
  if (/(deploy|canary|uptime|kubernetes|rollout|restart)/.test(t)) return [0, 1, 0];
  if (/(revenue|pricing|customers|margin)/.test(t)) return [0, 0, 1];
  return [0, 0, 0];
}

function topicEmbedder(): KbDenseEmbedder {
  return {
    async embedDocuments(documents) {
      return documents.map((chunks) => chunks.map((c) => topicVec(c)));
    },
    async embedQuery(query) {
      return topicVec(query);
    },
  };
}

describe("createLocalFsKnowledgeBase — hybrid dense lane", () => {
  beforeEach(async () => {
    // Two lexically-disjoint, single-topic docs. "safety" doc deliberately
    // shares NO query tokens with the dense query below (proves dense recall).
    await mkdir(join(dir, "kb"), { recursive: true });
    await writeFile(
      join(dir, "kb", "safety.md"),
      "## Keeping systems corrigible\nPowerful systems must stay corrigible and overseeable as they scale.\n",
    );
    await writeFile(
      join(dir, "kb", "ops.md"),
      "## Canary deploys\nRolling restart and canary rollout keep uptime high during releases.\n",
    );
  });

  it("rescues a lexically-disjoint but semantically-related chunk BM25 misses", async () => {
    const enabled = createLocalFsKnowledgeBase({
      dir,
      watch: false,
      includeDirs: ["kb"],
      dense: { enabled: true, embedder: topicEmbedder() },
    });
    const off = createLocalFsKnowledgeBase({
      dir,
      watch: false,
      includeDirs: ["kb"],
    });

    // "AI guardrails oversight" shares no tokens with safety.md's body, so BM25
    // finds nothing; the dense lane (same safety topic vector) surfaces it.
    const q = "AI guardrails oversight";
    expect(await off.search(q, 5)).toEqual([]); // pure BM25: no lexical overlap
    const hybrid = await enabled.search(q, 5);
    expect(hybrid.length).toBeGreaterThan(0);
    expect(hybrid[0]!.source.filePath).toContain("safety.md");
    // Dense-only hit ⇒ BM25-scale score is 0 (so it cannot lift the gate).
    expect(hybrid[0]!.score).toBe(0);

    enabled.close();
    off.close();
  });

  it("preserves the BM25-max score (relevance gate is non-regressive)", async () => {
    // A query with REAL lexical overlap on ops.md, plus a dense pull toward
    // safety.md. The gate keys on max(score); it must match the pure-BM25 max.
    const q = "canary rollout uptime";
    const off = createLocalFsKnowledgeBase({ dir, watch: false, includeDirs: ["kb"] });
    const on = createLocalFsKnowledgeBase({
      dir,
      watch: false,
      includeDirs: ["kb"],
      dense: { enabled: true, embedder: topicEmbedder() },
    });

    const offHits = await off.search(q, 5);
    const onHits = await on.search(q, 5);
    expect(offHits.length).toBeGreaterThan(0);
    const maxOff = Math.max(...offHits.map((h) => h.score));
    const maxOn = Math.max(...onHits.map((h) => h.score));
    expect(maxOn).toBe(maxOff); // gate sees the identical ceiling
    // The ops.md chunk keeps its exact BM25 score under hybrid.
    const opsOff = offHits.find((h) => h.source.filePath.includes("ops.md"))!;
    const opsOn = onHits.find((h) => h.source.filePath.includes("ops.md"))!;
    expect(opsOn.score).toBe(opsOff.score);

    off.close();
    on.close();
  });

  it("guarantees the top BM25 hit stays in the returned window (gate guard)", async () => {
    // topK=1, but the query is dense-aligned to safety.md while BM25 strongly
    // matches ops.md. The gate guard must keep the BM25-max (ops.md) as the
    // single returned hit, with its real score — never let a dense-only chunk
    // (score 0) displace it out of the window.
    const kb = createLocalFsKnowledgeBase({
      dir,
      watch: false,
      includeDirs: ["kb"],
      // Query embeds to the safety topic, pulling safety.md up in the dense lane.
      dense: { enabled: true, embedder: topicEmbedder(), poolSize: 10 },
    });
    // "canary rollout" → BM25 hits ops.md; "overseeable" → dense pulls safety.md.
    const hits = await kb.search("canary rollout overseeable", 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.source.filePath).toContain("ops.md");
    expect(hits[0]!.score).toBeGreaterThan(0);
    kb.close();
  });

  it("scopes hybrid hits to filterDirs", async () => {
    await mkdir(join(dir, "other"), { recursive: true });
    await writeFile(
      join(dir, "other", "safety2.md"),
      "## More safety\nCorrigible oversight and alignment guardrails matter.\n",
    );
    const kb = createLocalFsKnowledgeBase({
      dir,
      watch: false,
      dense: { enabled: true, embedder: topicEmbedder() },
    });
    const hits = await kb.search("guardrails oversight", 8, { filterDirs: ["kb"] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.source.filePath.startsWith("kb/"))).toBe(true);
    expect(hits.some((h) => h.source.filePath.includes("other"))).toBe(false);
    kb.close();
  });

  it("fails open to BM25 when the query embed throws (never throws)", async () => {
    const throwingEmbedder: KbDenseEmbedder = {
      async embedDocuments(documents) {
        return documents.map((chunks) => chunks.map((c) => topicVec(c)));
      },
      async embedQuery() {
        throw new Error("voyage down");
      },
    };
    const kb = createLocalFsKnowledgeBase({
      dir,
      watch: false,
      includeDirs: ["kb"],
      dense: { enabled: true, embedder: throwingEmbedder },
    });
    // BM25 still works; a dense-disjoint query just returns the BM25 hits.
    const hits = await kb.search("canary rollout uptime", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.source.filePath).toContain("ops.md");
    kb.close();
  });

  it("degrades to BM25 order when the corpus embed fails (all null)", async () => {
    const nullEmbedder: KbDenseEmbedder = {
      async embedDocuments(documents) {
        return documents.map(() => null); // every file failed to embed
      },
      async embedQuery(query) {
        return topicVec(query);
      },
    };
    const kb = createLocalFsKnowledgeBase({
      dir,
      watch: false,
      includeDirs: ["kb"],
      dense: { enabled: true, embedder: nullEmbedder },
    });
    // No dense vectors → dense ranking empty → fused == BM25.
    const hits = await kb.search("canary rollout uptime", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.source.filePath).toContain("ops.md");
    // A purely-dense query now finds nothing (no lexical overlap, no vectors).
    expect(await kb.search("AI guardrails oversight", 5)).toEqual([]);
    kb.close();
  });

  it("applies the optional rerank-2.5 layer over the fused pool", async () => {
    // rerank reorders the fused top: stub it to rank ops.md (doc index 1) first.
    const ORIGINAL_KEY = process.env["VOYAGE_API_KEY"];
    process.env["VOYAGE_API_KEY"] = "k";
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/rerank")) {
        // The fused docs are passed in some order; force index 1 to the top.
        return new Response(
          JSON.stringify({ data: [
            { index: 1, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.1 },
          ] }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const kb = createLocalFsKnowledgeBase({
        dir,
        watch: false,
        includeDirs: ["kb"],
        dense: { enabled: true, embedder: topicEmbedder(), rerank: true, poolSize: 10 },
      });
      // A query both docs partially match, so the fused pool has ≥2 entries.
      const hits = await kb.search("canary corrigible", 8);
      expect(hits.length).toBeGreaterThanOrEqual(2);
      // The rerank stub was consulted.
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/rerank"))).toBe(true);
      kb.close();
    } finally {
      vi.unstubAllGlobals();
      if (ORIGINAL_KEY === undefined) delete process.env["VOYAGE_API_KEY"];
      else process.env["VOYAGE_API_KEY"] = ORIGINAL_KEY;
    }
  });

  it("preserves the best lexical anchor and its gate score after a partial rerank", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "fixture-key");
    const off = createLocalFsKnowledgeBase({ dir, watch: false, includeDirs: ["kb"] });
    const fetchImpl: typeof fetch = async (_url, init) => {
      const { documents } = JSON.parse(String(init?.body)) as { documents: string[] };
      return Response.json({ data: [{ index: documents.findIndex(body => body.includes("corrigible")), relevance_score: 0.9 }] });
    };
    const on = createLocalFsKnowledgeBase({ dir, watch: false, includeDirs: ["kb"],
      dense: { enabled: true, embedder: topicEmbedder(), rerank: true, fetchImpl } });
    try {
      const query = "canary rollout overseeable";
      const pure = await off.search(query, 2), hybrid = await on.search(query, 2);
      expect(hybrid).toHaveLength(2);
      expect(hybrid.some(hit => hit.source.filePath.includes("ops.md"))).toBe(true);
      expect(Math.max(...hybrid.map(hit => hit.score))).toBe(Math.max(...pure.map(hit => hit.score)));
    } finally { on.close(); off.close(); vi.unstubAllEnvs(); }
  });

  it("is byte-identical to pure BM25 when dense is disabled (enabled:false)", async () => {
    const off = createLocalFsKnowledgeBase({ dir, watch: false, includeDirs: ["kb"] });
    const explicitlyOff = createLocalFsKnowledgeBase({
      dir,
      watch: false,
      includeDirs: ["kb"],
      dense: { enabled: false, embedder: topicEmbedder() },
    });
    const q = "canary rollout uptime";
    const a = (await off.search(q, 5)).map((h) => [h.source.filePath, h.score]);
    const b = (await explicitlyOff.search(q, 5)).map((h) => [h.source.filePath, h.score]);
    expect(b).toEqual(a);
    off.close();
    explicitlyOff.close();
  });
});

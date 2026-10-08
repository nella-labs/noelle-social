import { createBudgetedBackend, unlimitedBudget } from "@noelle/runtime";
import { describe, expect, it, vi } from "vitest";
import { ApifyError } from "@noelle/linkedin-apify";
import {
  runAccountFeederTick,
  isApifyQuotaError,
  type FeederTickDeps,
} from "./account-feeder-tick.js";
import type { StylePostUpsert, CorpusItem } from "../lib/account-feeder-db.js";

const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const instance = { id: "inst-1", org_id: "org-1" } as never;
const source = { id: "src-1", handle: "kaia-tham", platform: "linkedin", displayName: "Kaia", note: null };

// Minimal LinkedInPost / LinkedInComment fixtures (only the fields the tick reads).
const post = (id: string, text: string, reactions: number, comments: number) => ({
  id,
  urn: `urn:li:activity:${id}`,
  text,
  url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}`,
  postedAt: "2026-06-18T00:00:00.000Z",
  reactions,
  comments,
  author: { name: "Kaia", publicId: "kaia-tham", url: "u", headline: "Founder" },
});
const comment = (id: string, text: string, reactions: number, replies: number) => ({
  id,
  url: "https://www.linkedin.com/feed/update/x?commentUrn=y",
  text,
  authorName: "Kaia",
  authorHeadline: "Founder",
  reactions,
  repliesCount: replies,
  createdAt: "2026-06-17T00:00:00.000Z",
});

const ULTRA_JSON = JSON.stringify({
  voice_summary: "Punchy operator who writes in short confident lines.",
  tone: "dry, punchy",
  structure_notes: "Opens with a one-line hook, then 2-3 short lines.",
  hook_patterns: ["leads with a bold claim", "opens with a number"],
  signature_phrases: ["ship it", "the real unlock"],
  top_topics: ["devtools", "founders", "ai agents"],
});

/**
 * Build a fully-mocked deps object with capture buffers. `apify`/`extractor` are
 * overridable so a test can inject a throwing client or a junk extractor.
 */
function makeDeps(over: Partial<FeederTickDeps> = {}): {
  deps: FeederTickDeps;
  captured: { corpus: StylePostUpsert[][]; corpusStore: StylePostUpsert[]; profiles: unknown[]; pulled: string[] };
  profilePosts: ReturnType<typeof vi.fn>;
  authoredComments: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
} {
  const corpusStore: StylePostUpsert[] = [];
  const captured = {
    corpus: [] as StylePostUpsert[][],
    corpusStore,
    profiles: [] as unknown[],
    pulled: [] as string[],
  };
  const profilePosts =
    (over.apify?.profilePosts as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn().mockResolvedValue([post("p1", "shipping a thing", 120, 8), post("p2", "dx matters", 40, 2)]);
  const authoredComments =
    (over.apify?.authoredComments as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn().mockResolvedValue([comment("c1", "totally agree, this is the unlock", 9, 1)]);
  const call =
    (over.extractor?.call as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn().mockResolvedValue({ text: ULTRA_JSON, usage: { input_tokens: 500, output_tokens: 120 } });

  const deps: FeederTickDeps = {
    log,
    instance,
    sources: over.sources ?? [source],
    apify: { profilePosts, authoredComments } as never,
    extractor: { call } as never,
    upsertStylePosts: vi.fn(async (rows: StylePostUpsert[]) => {
      captured.corpus.push(rows);
      corpusStore.push(...rows);
      return rows.length;
    }),
    // Replay what was stored into the corpus for THIS account as the extractor input.
    getCorpus: vi.fn(async (a): Promise<CorpusItem[]> =>
      corpusStore
        .filter((r) => r.accountHandle === a.accountHandle && r.platform === a.platform)
        .map((r) => ({
          externalId: r.externalId,
          kind: r.kind,
          body: r.body,
          likeCount: r.likeCount,
          commentCount: r.commentCount,
          postedAt: r.postedAt ?? null,
        })),
    ),
    upsertUltraProfile: vi.fn(async (p) => {
      captured.profiles.push(p);
    }),
    markSourcePulled: vi.fn(async (id: string) => {
      captured.pulled.push(id);
    }),
    recorder: { record: vi.fn().mockResolvedValue(undefined) },
    credentialId: "cred-1",
  };
  return { deps, captured, profilePosts, authoredComments, call };
}

describe("runAccountFeederTick", () => {
  it("binds each returned embedding to the exact captured source text", async () => {
    const { deps } = makeDeps({ sources: [] });
    const body = "  Captured café\n";
    deps.listUnembeddedStylePosts = async () => [{ id: "post", body }];
    deps.embed = async texts => { expect(texts).toEqual([body]); return [[1, 0]]; };
    deps.updateStylePostEmbeddings = async rows =>
      rows.filter(row => row.body === body).length;
    expect((await runAccountFeederTick(deps)).embeddedRows).toBe(1);
  });
  it("retains unknown source measurements and labels them without invented zeroes", async () => {
    const { deps, captured, call } = makeDeps({ apify: {
      profilePosts: vi.fn().mockResolvedValue([{ ...post("p", "Saved detail", 0, 0), reactions: null, comments: null }]),
      authoredComments: vi.fn().mockResolvedValue([{ ...comment("c", "Saved reply", 0, 0), reactions: null, repliesCount: null }]),
    } as never });
    await runAccountFeederTick(deps);
    expect(captured.corpusStore.map(row => [row.likeCount, row.commentCount])).toEqual([[null, null], [null, null]]);
    expect(call.mock.calls[0]?.[0].prompt).toContain("unknown reactions");
    expect(call.mock.calls[0]?.[0].prompt).not.toContain("0 reactions");
    expect(captured.profiles[0]).toMatchObject({ avgLikeCount: null, avgCommentCount: null, samplePostIds: [] });
  });
  it("pulls posts + authored comments, stores them as corpus with the right kind + counts", async () => {
    const { deps, captured, profilePosts, authoredComments } = makeDeps();

    const res = await runAccountFeederTick(deps);

    // Pulled both lanes, by public slug, with the configured (default) limits.
    expect(profilePosts).toHaveBeenCalledWith({ publicId: "kaia-tham", maxPosts: 40 });
    expect(authoredComments).toHaveBeenCalledWith({ publicId: "kaia-tham", maxComments: 40 });

    // 2 posts + 1 comment = 3 corpus rows, all for this account.
    expect(res.corpusRows).toBe(3);
    expect(captured.corpusStore).toHaveLength(3);

    const posts = captured.corpusStore.filter((r) => r.kind === "post");
    const comments = captured.corpusStore.filter((r) => r.kind === "comment");
    expect(posts).toHaveLength(2);
    expect(comments).toHaveLength(1);

    // Post counts come from reactions/comments; comment counts from reactions/repliesCount.
    const p1 = posts.find((r) => r.externalId === "p1");
    expect(p1?.likeCount).toBe(120);
    expect(p1?.commentCount).toBe(8);
    expect(p1?.body).toBe("shipping a thing");
    const c1 = comments[0];
    expect(c1?.likeCount).toBe(9);
    expect(c1?.commentCount).toBe(1); // repliesCount
    expect(c1?.kind).toBe("comment");

    // Every corpus row is org/instance scoped — none could be a lead.
    for (const r of captured.corpusStore) {
      expect(r.orgId).toBe("org-1");
      expect(r.agentInstanceId).toBe("inst-1");
    }

    // Source stamped as pulled.
    expect(captured.pulled).toEqual(["src-1"]);
  });

  it("fans out a Gemini extractor per source and upserts an ultra profile + perf rollup", async () => {
    const { deps, captured, call } = makeDeps();

    const res = await runAccountFeederTick(deps);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0]?.model).toBe("gemini-2-5-flash");
    expect(res.profilesWritten).toBe(1);
    expect(captured.profiles).toHaveLength(1);

    const profile = captured.profiles[0] as Record<string, unknown>;
    expect(profile.accountHandle).toBe("kaia-tham");
    expect(profile.platform).toBe("linkedin");
    expect(profile.voiceSummary).toBe("Punchy operator who writes in short confident lines.");
    expect(profile.tone).toBe("dry, punchy");
    expect(profile.hookPatterns).toEqual(["leads with a bold claim", "opens with a number"]);
    expect(profile.topTopics).toEqual(["devtools", "founders", "ai agents"]);
    expect(profile.model).toBe("gemini-2-5-flash");

    // Perf rollup over the 3 stored items: likes [120,40,9] avg=56.33, comments [8,2,1] avg=3.67.
    expect(profile.postsAnalyzed).toBe(3);
    expect(profile.avgLikeCount).toBeCloseTo(56.33, 1);
    expect(profile.avgCommentCount).toBeCloseTo(3.67, 1);
    // Sample ids ranked by likes: p1(120) > p2(40) > c1(9).
    expect(profile.samplePostIds).toEqual(["p1", "p2", "c1"]);
  });

  it("meters BOTH Apify lanes + the Gemini call into the recorder (visibility)", async () => {
    const { deps } = makeDeps();
    deps.apify.drainLastRunUsd = () => 0.01;
    const record = deps.recorder!.record as ReturnType<typeof vi.fn>;


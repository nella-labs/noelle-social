import { beforeEach, describe, expect, it, vi } from "vitest";
const { readRules } = vi.hoisted(() => ({ readRules: vi.fn() }));
vi.mock("../lib/pattern-breaker-db.js", () => ({ loadActivePatternRules: readRules }));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const instance = {
  id: "22222222-2222-4222-8222-222222222222",
  org_id: "11111111-1111-4111-8111-111111111111",
  objective: "Share concrete lessons from building products",
  dm_autodraft_enabled: false,
};
beforeEach(() => {
  readRules.mockReset();
  vi.clearAllMocks();
});
async function replyTick(useCaptured = false) {
  const platform: string = "x";
  const { runDrafterTick } = await import("./drafter-tick.js");
  const sql = Object.assign(
    vi.fn(async () => []),
    { json: (value: unknown) => value },
  );
  const requests: unknown[] = [];
  const outbound: unknown[] = [];
  const statusWrites: unknown[] = [];
  const runner = {
    draft: async (request: unknown) => {
      requests.push(request);
      return {
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "the migration detail makes this useful", char_count: 43 },
            {
              angle: "technical",
              body: "the rollback path is a useful concrete constraint",
              char_count: 47,
            },
            {
              angle: "contrarian",
              body: "the deployment sequence is the interesting detail",
              char_count: 48,
            },
          ],
        }),
        engine: "fixture",
        model: "fixture",
      };
    },
  };
  const kb = {
    search: async () => [
      {
        path: "facts.md",
        snippet: "A concrete migration fact",
        score: 8,
        filePath: "facts.md",
        startLine: 1,
        endLine: 1,
        highlights: [],
      },
    ],
  };
  const lead = {
    id: "33333333-3333-4333-8333-333333333333",
    external_id: "7000000000000000001",
    author_handle: "builder",
    author_id: "author",
    status: "drafting",
    priority: false,
    tier: "T1",
    classifier_label: "substantial",
    classifier_score: 92,
    payload: {
      text: "We shipped a migration tool with a safe rollback path",
      title: "Migration tool",
      url:
        platform === "linkedin"
          ? "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/"
          : platform === "reddit"
            ? "https://www.reddit.com/r/SaaS/comments/abc123/"
            : "https://x.com/builder/status/7000000000000000001",
      authorPublicId: "builder",
      authorName: "Builder",
      subreddit: "SaaS",
      score: 10,
      numComments: 2,
    },
  };
  const completion = runDrafterTick({
    ...(useCaptured ? { patternRules: [] } : {}),
    log,
    instance,
    claimedLeads: [lead],
    runner,
    kb,
    sql,
    postOutbound: async (body: unknown) => {
      outbound.push(body);
      return { id: "a", approval_id: "a" };
    },
    markStatus: async (write: unknown) => {
      statusWrites.push(write);
    },
  } as unknown as Parameters<typeof runDrafterTick>[0]);
  await completion.catch(() => undefined);
  return { requests, outbound, statusWrites, sql };
}

describe("complete standing-rule admission", () => {
  it.each(["unavailable", "malformed", "overflow"])(
    "dispatches nothing after %s rules",
    async (failure) => {
      readRules.mockRejectedValue(new Error(`Standing rules ${failure}`));
      const effects = await replyTick();
      expect(readRules).toHaveBeenCalledOnce();
      expect(effects.requests).toEqual([]);
      expect(effects.outbound).toEqual([]);
      expect(effects.statusWrites).toEqual([]);
    },
  );
  it("reuses the supervisor's admitted snapshot without a second rule read", async () => {
    readRules.mockRejectedValue(new Error("A second read would be unavailable"));
    const effects = await replyTick(true);
    expect(readRules).not.toHaveBeenCalled();
    expect(effects.requests).toHaveLength(1);
    expect(effects.outbound).toHaveLength(1);
  });
  it("drafts with a verified complete empty set", async () => {
    readRules.mockResolvedValue([]);
    const effects = await replyTick();
    expect(readRules).toHaveBeenCalledOnce();
    expect(effects.requests).toHaveLength(1);
    expect(effects.outbound).toHaveLength(1);
    expect(effects.statusWrites).toContainEqual(expect.objectContaining({ status: "drafted" }));
  });
});

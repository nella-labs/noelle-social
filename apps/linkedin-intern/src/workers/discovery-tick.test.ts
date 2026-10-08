import { describe, expect, it, vi } from "vitest";
import { runDiscoveryTick } from "./discovery-tick.js";
import { createRepollGate } from "@noelle/runtime/repoll-cooldown";

const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const post = (id: string, text = "hello") => ({
  id,
  urn: `urn:li:activity:${id}`,
  text,
  url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
  postedAt: "2026-06-08T00:00:00.000Z",
  reactions: 5,
  comments: 1,
  author: {
    name: "Jane Builder",
    publicId: "jane-builder",
    url: "https://www.linkedin.com/in/jane-builder",
    headline: "Founder @ Acme",
  },
});

const person = {
  id: "wp1",
  fsdProfileId: "ABC123",
  publicId: "jane-builder",
  name: "Jane Builder",
  headline: "Founder @ Acme",
  objective: null,
  addedAt: "2026-06-01T00:00:00.000Z",
};

const CAP = 80;

describe("runDiscoveryTick (linkedin / apify)", () => {
  it.each(["watch", "keyword", "profile_search"] as const)("normalizes source dates in the %s lane without fabricating current time", async (lane) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T18:00:00.000Z"));
    try {
      for (const postedAt of ["", "2026-02-30T12:00:00Z", "2026-10-05T12:34:56.000Z"]) {
        const upsertLead = vi.fn().mockResolvedValue({ id: "L", inserted: true });
        const source = { ...post("date"), postedAt };
        await runDiscoveryTick({
          log, instance: { id: "i", org_id: "o" } as never,
          watchlistPeople: lane === "watch" ? [person] : [],
          postsSource: { profilePosts: async () => [source], searchPosts: async () => [source],
            searchProfiles: async () => [{ publicId: "jane-builder", name: "Jane", headline: "Founder", url: person.publicId, fsdProfileId: null }] },
          discoveryLimit: 5, dailyExtractCap: CAP, alreadyExtractedToday: 0, upsertLead,
          ...(lane === "keyword" ? { keywords: ["builders"], keywordConfig: { searchLimit: 5, minReactions: 0, postedLimit: "week" } } : {}),
          ...(lane === "profile_search" ? { icp: { headlineKeywords: ["founder"], minReactions: 0, timeWindowHours: 24 } } : {}),
        });
        expect(upsertLead).toHaveBeenCalledOnce();
        const expected = postedAt === "2026-10-05T12:34:56.000Z" ? postedAt : null;
        expect(upsertLead.mock.calls[0]![0]).toMatchObject({ postedAt: expected, payload: { postedAt: expected } });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("records the Apify profilePosts spend as engine='apify' (worker 'discovery')", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const profilePosts = vi.fn().mockResolvedValue([post("1"), post("2"), post("3")]);
    const record = vi.fn().mockResolvedValue(undefined);
    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [person],
      postsSource: { profilePosts, drainLastRunUsd: () => 0.01 },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
      recorder: { record },
    });
    const apifyRows = record.mock.calls.map((c) => c[0]).filter((r) => r.engine === "apify");
    expect(apifyRows).toHaveLength(1);
    expect(apifyRows[0]!.worker).toBe("discovery");
    expect(apifyRows[0]!.model).toBe("apify/linkedin-profile-posts");
    expect(apifyRows[0]!.cents).toBe(1); // Reported receipt cost, independent of normalized length.
  });

  it("upserts each post as a NEW, UNCLASSIFIED linkedin lead (priority=true (watch lane), status set by upsert)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const profilePosts = vi.fn().mockResolvedValue([post("1"), post("2")]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [person],
      postsSource: { profilePosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(inserted).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    // platform=linkedin, author_handle = public_id. The WATCH lane marks leads
    // priority=true — a hand-picked connection's post is never hard-skipped (the
    // classifier clamps a 'skip' verdict to 'light').
    const firstCall = upsert.mock.calls[0]![0];
    expect(firstCall.platform).toBe("linkedin");
    expect(firstCall.externalId).toBe("1");
    expect(firstCall.authorHandle).toBe("jane-builder");
    expect(firstCall.authorId).toBe("ABC123");
    expect(firstCall.priority).toBe(true);
    // payload carries text/url/author fields.
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          text: "hello",
          authorName: "Jane Builder",
          authorHeadline: "Founder @ Acme",
          authorPublicId: "jane-builder",
        }),
      }),
    );
  });

  it("threads post.images onto the lead payload when the post has media", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const withImages = {
      ...post("img"),
      images: ["https://media.licdn.com/a.jpg", "https://media.licdn.com/b.jpg"],
    };
    const profilePosts = vi.fn().mockResolvedValue([withImages]);

    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [person],
      postsSource: { profilePosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          images: ["https://media.licdn.com/a.jpg", "https://media.licdn.com/b.jpg"],
        }),
      }),
    );
  });

  it("omits the images key on a text-only post (no media)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    // post() has no images field at all.
    const profilePosts = vi.fn().mockResolvedValue([post("noimg")]);

    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [person],
      postsSource: { profilePosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    const payload = upsert.mock.calls[0]![0].payload;
    expect("images" in payload).toBe(false);
  });

  it("is gentle: fetches by public_id with the small limit + the person's added_at as sinceISO", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const profilePosts = vi.fn().mockResolvedValue([]);

    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [person],
      postsSource: { profilePosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(profilePosts).toHaveBeenCalledWith({
      publicId: "jane-builder",
      maxPosts: 5,
      sinceISO: "2026-06-01T00:00:00.000Z",
    });
  });

  it("skips a person with no public_id (Apify can't query without it)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const profilePosts = vi.fn().mockResolvedValue([post("1")]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [{ ...person, publicId: null }],
      postsSource: { profilePosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(profilePosts).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(inserted).toBe(0);
  });

  it("continues to the next person when one person's fetch throws", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const profilePosts = vi
      .fn()
      .mockRejectedValueOnce(new Error("apify error"))
      .mockResolvedValueOnce([post("9")]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [person, { ...person, id: "wp2", fsdProfileId: "XYZ", publicId: "two" }],
      postsSource: { profilePosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(inserted).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: "9" }));
  });

  it("does NOT fetch when already at the daily extract cap", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const profilePosts = vi.fn().mockResolvedValue([post("1")]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [person],
      postsSource: { profilePosts },
      discoveryLimit: 5,
      dailyExtractCap: 80,
      alreadyExtractedToday: 80,
      upsertLead: upsert,
    });

    expect(inserted).toBe(0);
    expect(profilePosts).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("stops inserting mid-tick the moment the running total hits the daily extract cap", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    // 5 fresh posts available, but only 2 slots left today (cap 80, already 78).
    const profilePosts = vi.fn().mockResolvedValue([post("1"), post("2"), post("3"), post("4"), post("5")]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [person],
      postsSource: { profilePosts },
      discoveryLimit: 5,
      dailyExtractCap: 80,
      alreadyExtractedToday: 78,
      upsertLead: upsert,
    });

    expect(inserted).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("only counts genuinely-new inserts (re-seen posts don't burn cap budget)", async () => {
    // First post is a re-seen no-op (inserted:false); second is new.
    const upsert = vi
      .fn()
      .mockResolvedValueOnce({ id: "L1", inserted: false })
      .mockResolvedValueOnce({ id: "L2", inserted: true });
    const profilePosts = vi.fn().mockResolvedValue([post("1"), post("2")]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [person],
      postsSource: { profilePosts },
      discoveryLimit: 5,
      dailyExtractCap: 80,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(inserted).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(2);
  });
});

describe("runDiscoveryTick — tailored run filters", () => {
  it("drops posts below the minReactions floor", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const lo = { ...post("lo"), reactions: 3 };
    const hi = { ...post("hi"), reactions: 40 };
    const profilePosts = vi.fn().mockResolvedValue([lo, hi]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [person],
      postsSource: { profilePosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
      filters: { timeWindowHours: null, minReactions: 10, minComments: null },
    });

    expect(inserted).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: "hi" }));
  });

  it("drops posts below the minComments floor", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const lo = { ...post("lo"), comments: 0 };
    const hi = { ...post("hi"), comments: 9 };
    const profilePosts = vi.fn().mockResolvedValue([lo, hi]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [person],
      postsSource: { profilePosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
      filters: { timeWindowHours: null, minReactions: null, minComments: 5 },
    });

    expect(inserted).toBe(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: "hi" }));
  });

  it("treats missing engagement as 0 — a floor drops posts Apify returned with no counts", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const noCounts = { ...post("x"), reactions: null, comments: null };
    const profilePosts = vi.fn().mockResolvedValue([noCounts]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [person],
      postsSource: { profilePosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
      filters: { timeWindowHours: null, minReactions: 1, minComments: null },
    });

    expect(inserted).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("a floor of 0 / null never filters (default behaviour preserved)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const profilePosts = vi.fn().mockResolvedValue([{ ...post("a"), reactions: 0, comments: 0 }]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [person],
      postsSource: { profilePosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
      filters: { timeWindowHours: null, minReactions: 0, minComments: null },
    });

    expect(inserted).toBe(1);
  });

  it("narrows the Apify sinceISO to the window and drops posts older than it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T00:00:00.000Z"));
    try {
      const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
      const old = { ...post("old"), postedAt: "2026-06-08T00:00:00.000Z" }; // 48h ago
      const fresh = { ...post("fresh"), postedAt: "2026-06-09T18:00:00.000Z" }; // 6h ago
      const profilePosts = vi.fn().mockResolvedValue([old, fresh]);

      const inserted = await runDiscoveryTick({
        log,
        instance: { id: "i", org_id: "o" } as never,
        watchlistPeople: [person], // added_at 2026-06-01 — older than the window
        postsSource: { profilePosts },
        discoveryLimit: 5,
        dailyExtractCap: CAP,
        alreadyExtractedToday: 0,
        upsertLead: upsert,
        filters: { timeWindowHours: 12, minReactions: null, minComments: null },
      });

      // sinceISO = later of (added_at, now − 12h) = the window bound.
      expect(profilePosts).toHaveBeenCalledWith(
        expect.objectContaining({ sinceISO: "2026-06-09T12:00:00.000Z" }),
      );
      // Client-side backstop: the 48h-old post is dropped, the 6h-old one kept.
      expect(inserted).toBe(1);
      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: "fresh" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("without filters, sinceISO stays the person's added_at (no window narrowing)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const profilePosts = vi.fn().mockResolvedValue([]);

    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [person],
      postsSource: { profilePosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
      filters: { timeWindowHours: null, minReactions: null, minComments: null },
    });

    expect(profilePosts).toHaveBeenCalledWith(
      expect.objectContaining({ sinceISO: "2026-06-01T00:00:00.000Z" }),
    );
  });
});

describe("runDiscoveryTick — keyword (search) lane", () => {
  // A search post carries its OWN (stranger) author + an author.type.
  const searchPost = (id: string, opts: { reactions?: number; type?: string; publicId?: string | null } = {}) => ({
    ...post(id),
    reactions: opts.reactions ?? 50,
    author: {
      name: "Stranger Founder",
      publicId: opts.publicId === undefined ? `stranger-${id}` : opts.publicId,
      url: "https://www.linkedin.com/in/stranger",
      headline: "Building in public",
      type: opts.type ?? "member",
    },
  });

  const kwConfig = { searchLimit: 15, minReactions: 10, postedLimit: "week" };

  it("searches each keyword and upserts results as keyword-source leads (author_id null)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const searchPosts = vi
      .fn()
      .mockResolvedValueOnce([searchPost("s1"), searchPost("s2")])
      .mockResolvedValueOnce([searchPost("s3"), searchPost("s4")]);
    const profilePosts = vi.fn().mockResolvedValue([]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [],
      keywords: ["ai agents", "yc"],
      keywordConfig: kwConfig,
      postsSource: { profilePosts, searchPosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(searchPosts).toHaveBeenCalledTimes(2); // one per keyword
    expect(searchPosts).toHaveBeenCalledWith(
      expect.objectContaining({ queries: ["ai agents"], maxPosts: 15, postedLimit: "week" }),
    );
    expect(inserted).toBe(4);
    const call = upsert.mock.calls[0]![0];
    expect(call.authorHandle).toBe("stranger-s1");
    expect(call.authorId).toBeNull();
    expect(call.payload.source).toBe("keyword");
    expect(call.payload.keyword).toBe("ai agents");
  });

  it("threads post.images onto keyword-lane leads (parity with the watch lane)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const withImages = {
      ...searchPost("s1"),
      images: ["https://media.licdn.com/x.jpg", "https://media.licdn.com/y.jpg"],
    };
    const searchPosts = vi.fn().mockResolvedValueOnce([withImages]);

    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [],
      keywords: ["ai agents"],
      keywordConfig: kwConfig,
      postsSource: { profilePosts: vi.fn().mockResolvedValue([]), searchPosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(upsert.mock.calls[0]![0].payload.images).toEqual([
      "https://media.licdn.com/x.jpg",
      "https://media.licdn.com/y.jpg",
    ]);
  });

  it("omits the images key on a text-only keyword-lane post", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const searchPosts = vi.fn().mockResolvedValueOnce([searchPost("s1")]);

    await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [],
      keywords: ["ai agents"],
      keywordConfig: kwConfig,
      postsSource: { profilePosts: vi.fn().mockResolvedValue([]), searchPosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect("images" in upsert.mock.calls[0]![0].payload).toBe(false);
  });

  it("skips company-authored posts (objective targets people, not company promo)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const searchPosts = vi
      .fn()
      .mockResolvedValue([searchPost("co", { type: "company" }), searchPost("person", { type: "member" })]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [],
      keywords: ["startup"],
      keywordConfig: kwConfig,
      postsSource: { profilePosts: vi.fn().mockResolvedValue([]), searchPosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(inserted).toBe(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: "person" }));
  });

  it("drops posts below the keyword reaction floor (the lane's whole purpose)", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const searchPosts = vi
      .fn()
      .mockResolvedValue([searchPost("lo", { reactions: 4 }), searchPost("hi", { reactions: 99 })]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [],
      keywords: ["startup"],
      keywordConfig: { ...kwConfig, minReactions: 10 },
      postsSource: { profilePosts: vi.fn().mockResolvedValue([]), searchPosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(inserted).toBe(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: "hi" }));
  });

  it("skips a search post with no resolvable author public id", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "L", inserted: true });
    const searchPosts = vi.fn().mockResolvedValue([searchPost("x", { publicId: null })]);

    const inserted = await runDiscoveryTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      watchlistPeople: [],
      keywords: ["startup"],
      keywordConfig: kwConfig,
      postsSource: { profilePosts: vi.fn().mockResolvedValue([]), searchPosts },
      discoveryLimit: 5,
      dailyExtractCap: CAP,
      alreadyExtractedToday: 0,
      upsertLead: upsert,
    });

    expect(inserted).toBe(0);
    expect(upsert).not.toHaveBeenCalled();

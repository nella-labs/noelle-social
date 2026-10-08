import { describe, it, expect, vi } from "vitest";
import {
  pickSeeds,
  readSeedHandles,
  runFollowerFeeder,
  isFeederDue,
} from "./follower-feeder.js";

const icpGate = { headlineKeywords: ["founder", "devtools"], headlineExcludeKeywords: ["crypto"] };
const log = { info: vi.fn() };

const person = (handle: string, bio: string | null) => ({
  handle,
  id: `${handle}-id`,
  displayName: handle,
  bio,
  followers: 500,
});

describe("pickSeeds", () => {
  it("prefers configured seeds over the watchlist", () => {
    expect(pickSeeds({ configured: ["a"], watchlist: ["b", "c"] }, 3, 0)).toEqual(["a"]);
  });

  it("falls back to the watchlist when nothing is configured", () => {
    expect(pickSeeds({ configured: [], watchlist: ["b", "c"] }, 1, 0)).toEqual(["b"]);
  });

  it("normalises and de-dupes handles", () => {
    expect(pickSeeds({ configured: ["@A", "a", " A "], watchlist: [] }, 5, 0)).toEqual(["a"]);
  });

  it("rotates by cursor so a long seed list is covered over successive runs", () => {
    const src = { configured: ["a", "b", "c"], watchlist: [] };
    expect(pickSeeds(src, 1, 0)).toEqual(["a"]);
    expect(pickSeeds(src, 1, 1)).toEqual(["b"]);
    expect(pickSeeds(src, 1, 2)).toEqual(["c"]);
    expect(pickSeeds(src, 1, 3)).toEqual(["a"]); // wraps
  });

  it("never returns more seeds than perRun (each seed is a PAID run)", () => {
    const src = { configured: ["a", "b", "c", "d"], watchlist: [] };
    expect(pickSeeds(src, 2, 0)).toHaveLength(2);
    expect(pickSeeds(src, 0, 0)).toEqual([]);
  });

  it("returns nothing when there are no seeds anywhere", () => {
    expect(pickSeeds({ configured: [], watchlist: [] }, 3, 0)).toEqual([]);
  });
});

describe("readSeedHandles", () => {
  it("reads seedHandles and ignores unrelated config keys", () => {
    expect(readSeedHandles({ seedHandles: ["a", "b"], headlineKeywords: ["x"] })).toEqual(["a", "b"]);
  });

  it("returns [] for every malformed shape", () => {
    for (const cfg of [null, undefined, 42, "str", {}, { seedHandles: "a" }, { seedHandles: [1, 2] }]) {
      expect(readSeedHandles(cfg)).toEqual([]);
    }
  });
});

describe("isFeederDue — the spend throttle", () => {
  const now = new Date("2026-07-26T12:00:00.000Z");

  it("runs when it has never run", () => {
    expect(isFeederDue(null, 24, now)).toBe(true);
  });

  it("skips inside the window and runs after it", () => {
    expect(isFeederDue("2026-07-26T00:00:00.000Z", 24, now)).toBe(false); // 12h ago
    expect(isFeederDue("2026-07-25T11:00:00.000Z", 24, now)).toBe(true); // 25h ago
  });

  it("SKIPS on an unparseable stamp — a bus glitch must not cost money", () => {
    // Fail-safe direction: unreadable state means "assume recent", not "spend".
    expect(isFeederDue("not-a-date", 24, now)).toBe(false);
  });
});

describe("runFollowerFeeder", () => {
  it("retains only the people whose bio matches the ICP", async () => {
    const recordPerson = vi.fn().mockResolvedValue(undefined);
    const r = await runFollowerFeeder({
      sql: {} as never,
      orgId: "o",
      agentInstanceId: "i",
      icpGate,
      seeds: ["seed"],
      maxUsers: 10,
      scrapeFollowers: async () => ({
        people: [
          person("good", "founder building devtools"),
          person("bad", "crypto degen"),
          person("meh", "photographer"),
        ],
        resultCount: 3,
      }),
      recordPerson,
      log,
    });
    expect(r.qualified).toBe(1);
    expect(recordPerson).toHaveBeenCalledTimes(1);
    expect(recordPerson).toHaveBeenCalledWith(expect.objectContaining({ handle: "good" }));
  });

  it("does NOT retain someone with no bio, and reports the count", async () => {
    // Retention fails CLOSED: an unvetted handle would just cost us a poll later.
    const recordPerson = vi.fn().mockResolvedValue(undefined);
    const r = await runFollowerFeeder({
      sql: {} as never,
      orgId: "o",
      agentInstanceId: "i",
      icpGate,
      seeds: ["seed"],
      maxUsers: 10,
      scrapeFollowers: async () => ({ people: [person("nobio", null)], resultCount: 1 }),
      recordPerson,
      log,
    });
    expect(recordPerson).not.toHaveBeenCalled();
    // Surfaced so an actor that stops returning bios is visible, rather than
    // silently producing zero qualified people forever.
    expect(r.noBio).toBe(1);
  });

  it("SPENDS NOTHING when there are no seeds or the cap is zero", async () => {
    const scrapeFollowers = vi.fn();
    for (const args of [
      { seeds: [], maxUsers: 10 },
      { seeds: ["seed"], maxUsers: 0 },
    ]) {
      const r = await runFollowerFeeder({
        sql: {} as never,
        orgId: "o",
        agentInstanceId: "i",
        icpGate,
        scrapeFollowers,
        recordPerson: vi.fn(),
        log,
        ...args,
      });
      expect(r.qualified).toBe(0);
    }
    expect(scrapeFollowers).not.toHaveBeenCalled();
  });

  it("keeps going when retaining ONE person fails", async () => {
    const recordPerson = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(undefined);
    const r = await runFollowerFeeder({
      sql: {} as never,
      orgId: "o",
      agentInstanceId: "i",
      icpGate,
      seeds: ["seed"],
      maxUsers: 10,
      scrapeFollowers: async () => ({
        people: [person("a", "founder"), person("b", "devtools founder")],
        resultCount: 2,
      }),
      recordPerson,
      log,
    });
    expect(recordPerson).toHaveBeenCalledTimes(2);
    expect(r.qualified).toBe(2);
  });

  it("propagates a scrape failure so a dead token pool surfaces", async () => {
    await expect(
      runFollowerFeeder({
        sql: {} as never,
        orgId: "o",
        agentInstanceId: "i",
        icpGate,
        seeds: ["seed"],
        maxUsers: 10,
        scrapeFollowers: async () => {
          throw new Error("all apify tokens exhausted");
        },
        recordPerson: vi.fn(),
        log,
      }),
    ).rejects.toThrow(/exhausted/);
  });
});

import { describe, expect, it } from "vitest";
import { mergeProfilerQueue } from "./profiler-queue.js";

const p = (handle: string) => ({ handle, addedAt: "2026-07-01T00:00:00Z" });

describe("mergeProfilerQueue", () => {
  it("puts watchlist people first, then high-reply authors", () => {
    const out = mergeProfilerQueue({
      watchlist: [p("alice")],
      replied: [p("bob"), p("carol")],
      batch: 5,
    });
    expect(out.map((x) => x.handle)).toEqual(["alice", "bob", "carol"]);
  });

  it("dedupes across lanes case-insensitively (X handles are case-preserving)", () => {
    // Same human, two spellings — profiling twice would cost two Apify fetches
    // and two LLM calls, and (worse) insert a twin row under the other casing.
    const out = mergeProfilerQueue({
      watchlist: [p("ElonMusk")],
      replied: [p("elonmusk"), p("@ElonMusk"), p("paulg")],
      batch: 5,
    });
    expect(out.map((x) => x.handle)).toEqual(["ElonMusk", "paulg"]);
  });

  it("caps at batch, and the watchlist never gets starved by the reply tail", () => {
    const out = mergeProfilerQueue({
      watchlist: [p("alice")],
      replied: [p("b"), p("c"), p("d"), p("e")],
      batch: 3,
    });
    expect(out.map((x) => x.handle)).toEqual(["alice", "b", "c"]);
  });

  it("returns [] when the batch is zero or every handle is blank", () => {
    expect(mergeProfilerQueue({ watchlist: [p("a")], replied: [], batch: 0 })).toEqual([]);
    expect(mergeProfilerQueue({ watchlist: [p("  ")], replied: [], batch: 3 })).toEqual([]);
  });
});

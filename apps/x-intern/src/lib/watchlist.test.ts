import { describe, expect, it, vi } from "vitest";
import { getWatchlist } from "./watchlist.js";

describe("getWatchlist", () => {
  it("splits rows by kind", async () => {
    const rows = [
      { kind: "handle", value: "patio11" },
      { kind: "handle", value: "balajis" },
      { kind: "keyword", value: "ai agents" },
    ];
    const sql = Object.assign(
      vi.fn(async () => rows),
      { unsafe: vi.fn() },
    ) as never;
    const wl = await getWatchlist(sql, "instance-1");
    expect(wl.handles).toEqual(["patio11", "balajis"]);
    expect(wl.keywords).toEqual(["ai agents"]);
  });
});

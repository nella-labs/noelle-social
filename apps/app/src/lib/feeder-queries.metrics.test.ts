import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ rows: [] as unknown[], read: vi.fn(), instance: { id: "instance", org_id: "org" } as { id: string; org_id: string } | null }));
vi.mock("@/lib/db", () => ({ readSql: fixture.read, sql: (...args: unknown[]) => ({ fragment: args }) }));
vi.mock("@/lib/queries", () => ({ getAgentInstance: () => fixture.instance }));
import { listStyleSamples } from "./feeder-queries";

beforeEach(() => {
  fixture.instance = { id: "instance", org_id: "org" };
  fixture.read.mockReset().mockImplementation(() => fixture.rows);
});

it("normalizes native bigint strings and preserves unknown measurements", async () => {
  fixture.rows = [{ account_handle: "source", kind: "post", body: "Measured source text",
    like_count: "2147483648", comment_count: null, posted_at: "2026-06-01 00:00:00+00" }];
  expect(await listStyleSamples("instance")).toEqual([{ handle: "source", kind: "post",
    body: "Measured source text", likeCount: 2147483648, commentCount: null,
    postedAt: "2026-06-01T00:00:00.000Z" }]);
});

it("treats native legacy negative and unsafe counters as unknown", async () => {
  fixture.rows = [{ account_handle: "source", kind: "post", body: "Legacy source text",
    like_count: "-1", comment_count: "9007199254740992", posted_at: null }];
  const [sample] = await listStyleSamples("instance");
  expect([sample?.likeCount, sample?.commentCount]).toEqual([null, null]);
});

it("does not read samples when membership has no instance", async () => {
  fixture.instance = null;
  expect(await listStyleSamples("instance")).toEqual([]);
  expect(fixture.read).not.toHaveBeenCalled();
});

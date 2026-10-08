import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { runContentMetricsTick } from "./content-metrics-tick.js";

function database(ids: string[]) {
  const snapshots: Array<Record<string, unknown>> = [];
  const selections: string[][] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (/insert into/i.test(strings.join(" "))) {
      snapshots.push(values[0] as Record<string, unknown>);
      return Promise.resolve([]);
    }
    const excluded = (values.find(Array.isArray) ?? []) as string[];
    const limit = values.at(-1) as number;
    const selected = ids.filter((id) => !excluded.includes(id)).slice(0, limit);
    selections.push(selected);
    return Promise.resolve(selected.map((tweet_id) => ({ tweet_id, slot_id: null, idea_id: null })));
  };
  return { sql: Object.assign(tag, { json: (value: unknown) => value }) as unknown as Sql, snapshots, selections };
}

function setup(ids: string[] = ["1", "2"]) {
  const db = database(ids);
  const reads: string[][] = [];
  const args = {
    sql: db.sql, instanceId: "instance", orgId: "org", windowDays: 30, maxPosts: 1,
    now: new Date("2026-10-05T12:00:00Z"),
    reader: { getTweetMetrics: async (selected: string[]) => {
      reads.push(selected);
      return selected.filter((id) => id !== "1").map((id) => ({
        id, views: 1000, likes: 10, reposts: 2, replies: 3, quotes: 0, bookmarks: null,
      }));
    } },
  };
  return { ...db, reads, args };
}

describe("content metrics missing-target cooldown", () => {
  it("rotates past an omitted tweet without writing a zero snapshot", async () => {
    const { args, reads, snapshots } = setup();
    expect(await runContentMetricsTick(args)).toEqual({ postsConsidered: 1, measured: 0 });
    expect(await runContentMetricsTick(args)).toEqual({ postsConsidered: 1, measured: 1 });
    expect(reads).toEqual([["1"], ["2"]]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ external_id: "2", likes: 10, quotes: 0, bookmarks: null });
  });

  it("retries an omitted tweet after fifteen minutes", async () => {
    const { args, reads } = setup();
    await runContentMetricsTick(args);
    await runContentMetricsTick({ ...args, now: new Date("2026-10-05T12:14:59Z") });
    await runContentMetricsTick({ ...args, now: new Date("2026-10-05T12:15:00Z") });
    expect(reads).toEqual([["1"], ["2"], ["1"]]);
  });

  it("skips a missing target for one following sweep when the cadence exceeds the cooldown", async () => {
    const { args, reads } = setup();
    await runContentMetricsTick(args);
    await runContentMetricsTick({ ...args, now: new Date("2026-10-05T15:00:00Z") });
    await runContentMetricsTick({ ...args, now: new Date("2026-10-05T18:00:00Z") });
    expect(reads).toEqual([["1"], ["2"], ["1"]]);
  });

  it("does not treat an auth or transport failure as a missing tweet", async () => {
    const { args, reads, snapshots } = setup();
    await runContentMetricsTick({ ...args, reader: { getTweetMetrics: async () => { throw new Error("401"); } } });
    await runContentMetricsTick(args);
    expect(reads).toEqual([["1"]]);
    expect(snapshots).toEqual([]);
  });

  it("scopes omitted targets to the SQL connection and instance", async () => {
    const { args, reads } = setup();
    await runContentMetricsTick(args);
    await runContentMetricsTick({ ...args, instanceId: "another" });
    const other = setup();
    await runContentMetricsTick(other.args);
    expect(reads).toEqual([["1"], ["1"]]);
    expect(other.reads).toEqual([["1"]]);
  });

  it("bounds missing targets to two hundred while retaining rotation", async () => {
    const { args, selections } = setup(Array.from({ length: 201 }, (_, i) => String(i + 1)));
    const emptyReader = { getTweetMetrics: async () => [] };
    await runContentMetricsTick({ ...args, reader: emptyReader, maxPosts: 200 });
    await runContentMetricsTick({ ...args, reader: emptyReader, maxPosts: 200 });
    await runContentMetricsTick({ ...args, reader: emptyReader, maxPosts: 1 });
    expect(selections.map((selected) => selected.length)).toEqual([200, 1, 1]);
    expect(selections[2]).toEqual(["1"]);
  });

  it("evicts the oldest instance cache after one hundred instances", async () => {
    const { args, reads } = setup(["1"]);
    for (let i = 0; i < 101; i++) await runContentMetricsTick({ ...args, instanceId: `instance-${i}` });
    await runContentMetricsTick({ ...args, instanceId: "instance-0" });
    expect(reads).toHaveLength(102);
  });

  it("does not read or write when disconnected or the cap is zero", async () => {
    const { args, reads, snapshots, selections } = setup();
    expect(await runContentMetricsTick({ ...args, reader: null })).toEqual({ postsConsidered: 0, measured: 0 });
    expect(await runContentMetricsTick({ ...args, maxPosts: 0 })).toEqual({ postsConsidered: 0, measured: 0 });
    expect(reads).toEqual([]);
    expect(snapshots).toEqual([]);
    expect(selections).toEqual([]);
  });
});

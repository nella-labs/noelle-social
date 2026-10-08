import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as owner from "./patternBreakerDb.js";
import {
  setup,
  reset,
  close,
  sql,
  foreignOrg,
  reboundOrg,
  instance,
  scope,
  operatorScope,
  rule,
  alert,
  queue,
  claim,
  apply,
} from "./patternBreakerDb.fixture.js";
const url = process.env.PATTERN_REFINER_DATABASE_URL;
describe.skipIf(!url)("Durable refinement dispatch and result authority (native)", () => {
  beforeAll(() => setup(url!));
  beforeEach(reset);
  afterAll(() => close(url!));
  it("claims each legacy pending request once before dispatch without an expiry replay", async () => {
    const r = await rule();
    const id = await alert(r);
    const [item] = await queue();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => owner.claimRefinement(sql, scope, item!)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await queue()).toEqual([]);
    const c = results.find(Boolean)!;
    expect(c.refine_request_id).toBeTruthy();
    expect(c.refine_claim_id).toBeTruthy();
    expect(await owner.claimRefinement(sql, scope, item!)).toBeNull();
    expect((await sql`select status from noelle.pattern_alerts where id=${id}`)[0]?.status).toBe(
      "refining",
    );
  });
  it("two actual shared ticks admit one model call and acknowledge one applied result", async () => {
    const r = await rule();
    await alert(r);
    const [item] = await queue();
    let entered!: () => void;
    const admission = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const call = vi.fn(async () => {
      entered();
      await gate;
      return JSON.stringify({ instruction: "Use a concrete detail instead of a stock closer" });
    });
    const args = {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      call,
      loadQueue: async () => [item!],
      claim: (item: owner.RefiningAlertRow) => owner.claimRefinement(sql, scope, item),
      applyRefined: (args: { claim: owner.CapturedPatternClaim; instruction: string | null }) =>
        owner.applyRefinedRule(sql, scope, { ...args, decidedBy: "worker" }),
    };
    const first = owner.runPatternRefine(args);
    await admission;
    const second = owner.runPatternRefine(args);
    expect(await second).toBe(0);
    finish();
    expect(await first).toBe(1);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("unusable output preserves automatic instruction/source and records a recoverable non-success", async () => {
    const r = await rule();
    const id = await alert(r);
    const c = await claim(id);
    expect(await apply(c, null)).toBe(false);
    const [row] = await sql`select instruction,source from noelle.pattern_rules where id=${r}`;
    expect(row).toEqual({ instruction: "Avoid reusing a stock closer", source: "auto" });
    const [view] = (await owner.loadVisibleAlerts(sql, scope)).alerts;
    expect(owner.patternAlertView(view!)).toMatchObject({
      status: "open",
      refineFailed: true,
      refineClaimed: true,
    });
    expect(await queue()).toEqual([]);
  });
  it("rotates an explicit expected-request retry once and rejects the old completion", async () => {
    const r = await rule();
    const id = await alert(r);
    const old = await claim(id);
    const retries = await Promise.all(
      Array.from({ length: 5 }, () =>
        owner.mutatePatternAlert(sql, operatorScope, {
          alertId: id,
          action: "refine",
          expectedRequestId: old.refine_request_id,
          decidedBy: "operator",
        }),
      ),
    );
    expect(retries.filter(Boolean)).toHaveLength(1);
    expect(await apply(old)).toBe(false);
    const fresh = await claim(id);
    expect(fresh.refine_request_id).not.toBe(old.refine_request_id);
    expect(await apply(fresh)).toBe(true);
  });
  it.each(["revert", "acknowledge"] as const)("cannot apply after operator %s", async (action) => {
    const r = await rule();
    const id = await alert(r);
    const c = await claim(id);
    expect(
      await owner.mutatePatternAlert(sql, operatorScope, {
        alertId: id,
        action,
        decidedBy: "operator",
      }),
    ).not.toBeNull();
    expect(await apply(c)).toBe(false);
    expect((await sql`select source from noelle.pattern_rules where id=${r}`)[0]?.source).toBe(
      "auto",
    );
  });
  it("rejects a manually changed instruction even without a timestamp trigger", async () => {
    const r = await rule();
    await alert(r);
    const c = await claim();
    await sql`update noelle.pattern_rules set instruction='Use only a measured specific detail' where id=${r}`;
    expect(await apply(c)).toBe(false);
  });
  it.each(["org_id", "role"])("rejects parent %s rebind after dispatch", async (field) => {
    const r = await rule();
    await alert(r);
    const c = await claim();
    if (field === "org_id")
      await sql`update noelle.agent_instances set org_id=${reboundOrg} where id=${instance}`;
    else await sql`update noelle.agent_instances set role='video_intern' where id=${instance}`;
    expect(await apply(c)).toBe(false);
  });
  it("filters malformed and foreign prefixes before selecting ten oldest eligible requests", async () => {
    const foreign = await rule({ org: foreignOrg });
    for (let i = 0; i < 12; i++) await alert(foreign);
    const malformed = await rule();
    for (let i = 0; i < 12; i++) {
      const id = await alert(malformed);
      await sql`update noelle.pattern_alerts set examples='{}' where id=${id}`;
    }
    const valid = await rule();
    for (let i = 0; i < 13; i++) await alert(valid);
    expect(await queue()).toHaveLength(10);
  });
  it("has no late queued rewrite after a held rule timeout and then recovers", async () => {
    const r = await rule();
    await alert(r);
    const c = await claim();
    const lock = await sql.reserve();
    await lock`begin`;
    await lock`select id from noelle.pattern_rules where id=${r} for update`;
    const writes = Array.from({ length: 8 }, () =>
      apply(c).then(
        () => "applied",
        () => "rejected",
      ),
    );
    await vi.waitFor(
      async () => {
        const [row] = await sql`select count(*)::int as n from pg_stat_activity
      where datname=current_database() and application_name='pattern-native' and wait_event_type='Lock'`;
        expect(row?.n).toBeGreaterThan(0);
      },
      { timeout: 800 },
    );
    expect(await Promise.all(writes)).toEqual(Array(8).fill("rejected"));
    await lock`rollback`;
    lock.release();
    expect((await sql`select source from noelle.pattern_rules where id=${r}`)[0]?.source).toBe(
      "auto",
    );
    expect(await apply(c)).toBe(true);
  });
  it.each(["org_id", "role"])(
    "rechecks a committed parent %s change after waiting for its lock",
    async (field) => {
      const r = await rule();
      await alert(r);
      const c = await claim();
      const lock = await sql.reserve();
      await lock`begin`;
      await lock`select id from noelle.agent_instances where id=${instance} for no key update`;
      const result = apply(c);
      try {
        await vi.waitFor(
          async () => {
            const [row] = await sql`select count(*)::int as n from pg_stat_activity
          where datname=current_database() and application_name='pattern-native'
            and wait_event_type='Lock' and query like '%agent_instances%'`;
            expect(row?.n).toBeGreaterThan(0);
          },

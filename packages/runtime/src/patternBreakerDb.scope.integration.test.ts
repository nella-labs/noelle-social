import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as owner from "./patternBreakerDb.js";
import {
  setup,
  reset,
  close,
  sql,
  org,
  foreignOrg,
  reboundOrg,
  instance,
  linkedin,
  scope,
  operatorScope,
  rule,
  alert,
  reply,
  post,
  corpus,
  rules,
  queue,
} from "./patternBreakerDb.fixture.js";
const url = process.env.PATTERN_REFINER_DATABASE_URL;
describe.skipIf(!url)("Pattern sources and current tenant (native)", () => {
  beforeAll(() => setup(url!));
  beforeEach(reset);
  afterAll(() => close(url!));
  it.each([
    ["missing kind", { kind: null }],
    ["DM", { kind: "dm" }],
    ["unconfirmed preclaim", { receipt: null }],
    ["foreign draft", { org: foreignOrg }],
    ["foreign approval", { approvalOrg: foreignOrg }],
    ["foreign lead", { leadOrg: foreignOrg }],
    ["another native instance", { leadInstance: linkedin }],
  ])("excludes %s from the learned reply corpus", async (_name, opts) => {
    await reply(opts);
    expect(await corpus()).toEqual([]);
  });
  it.each([
    ["foreign draft", { org: foreignOrg }],
    ["foreign idea", { ideaOrg: foreignOrg }],
    ["another home instance", { ideaInstance: linkedin }],
    ["contradictory platform", { platform: "linkedin" }],
  ])("excludes an original with %s", async (_name, opts) => {
    await post(opts);
    expect(await corpus()).toEqual([]);
  });
  it("keeps confirmed manual replies and legitimate home-instance cross-platform originals", async () => {
    const r = await reply({ receipt: "manual:explicit-ack" });
    const p = await post({ platform: "linkedin", ideaPlatform: "linkedin" });
    expect((await corpus()).map((row) => row.draftId).sort()).toEqual([r, p].sort());
  });
  it("uses a nonblank string edit and retains the original for malformed or blank edits", async () => {
    await reply({ editedBody: { arbitrary: "json" } });
    await reply({ editedBody: "  " });
    await reply({ editedBody: "An exact useful operator edit" });
    expect((await corpus()).map((row) => row.body).sort()).toEqual([
      "A useful reply with a stock closer",
      "A useful reply with a stock closer",
      "An exact useful operator edit",
    ]);
  });
  it("excludes oversized bodies before the capped corpus and preserves exact admitted whitespace", async () => {
    await reply({ body: "x".repeat(10001) });
    await reply({ body: "  Exact\nbody with a stock closer  " });
    expect((await corpus()).map((row) => row.body)).toEqual([
      "  Exact\nbody with a stock closer  ",
    ]);
  });
  it("bounds requested corpus size without making it a lifetime sample", async () => {
    for (let i = 0; i < 104; i++) await reply({ body: `A useful reply ${i}` });
    expect(await owner.loadRecentPosts(sql, scope, 100000)).toHaveLength(100);
    expect(await owner.loadRecentPosts(sql, scope, 3)).toHaveLength(3);
  });
  it.each(["org_id", "role"])("rechecks current parent %s in all reads", async (field) => {
    await reply();
    const r = await rule();
    await alert(r);
    if (field === "org_id")
      await sql`update noelle.agent_instances set org_id=${reboundOrg} where id=${instance}`;
    else await sql`update noelle.agent_instances set role='video_intern' where id=${instance}`;
    expect(await corpus()).toEqual([]);
    await expect(rules()).rejects.toThrow(/owner|unavailable/i);
    expect(await queue()).toEqual([]);
    await expect(owner.loadVisibleAlerts(sql, scope)).rejects.toThrow(/owner|unavailable/i);
  });
  it("excludes soft tenant rules, alerts and linked foreign rules", async () => {
    const foreign = await rule({ org: foreignOrg });
    await alert(foreign);
    const local = await rule();
    await alert(local, { org: foreignOrg });
    expect(await rules()).toHaveLength(1);
    expect(await queue()).toEqual([]);
    expect((await owner.loadVisibleAlerts(sql, scope)).alerts).toEqual([]);
  });
  it("checks operator membership again in the data owner", async () => {
    const r = await rule();
    const id = await alert(r, { status: "open" });
    await sql`delete from noelle.org_members where org_id=${org}`;
    expect(
      await owner.mutatePatternAlert(sql, operatorScope, {
        alertId: id,
        action: "revert",
        decidedBy: "operator",
      }),
    ).toBeNull();
    expect((await sql`select active from noelle.pattern_rules where id=${r}`)[0]?.active).toBe(
      true,
    );
  });
});

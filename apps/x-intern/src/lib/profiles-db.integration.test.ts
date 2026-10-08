import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listRepliedPeopleNeedingProfile } from "./profiles-db.js";
import {
  openProfilingFixture,
  profilingForeignOrg,
  profilingInstance,
  profilingOrg,
} from "./profiling-fixture.js";

const url = process.env.X_PROFILING_TEST_DATABASE_URL;
describe.skipIf(!url)("confirmed public reply profiling on native schemas", () => {
  let fixture: Awaited<ReturnType<typeof openProfilingFixture>>;
  beforeAll(async () => {
    fixture = await openProfilingFixture(url!);
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture?.close();
  });
  const queue = () =>
    listRepliedPeopleNeedingProfile(fixture.sql, {
      agentInstanceId: profilingInstance,
      minReplies: 0,
      windowDays: 30,
      staleDays: 3,
      batch: 20,
    });

  it("keeps confirmed public replies and explicit receipt-only legacy writes", async () => {
    await fixture.sent("public");
    await fixture.sent("receipt", { receiptOnly: true });
    expect((await queue()).map((row) => row.handle).sort()).toEqual(["public", "receipt"]);
  });
  it.each(["dm", null])("does not learn a public relationship from kind %s", async (kind) => {
    await fixture.sent("private", { kind });
    expect(await queue()).toEqual([]);
  });
  it("excludes status sent preclaims without a confirmed write", async () => {
    await fixture.sent("preclaim", { confirmed: false });
    expect(await queue()).toEqual([]);
  });
  it.each(["approvalOrg", "draftOrg", "leadOrg"] as const)(
    "rejects foreign %s soft references",
    async (field) => {
      await fixture.sent("foreign", { [field]: profilingForeignOrg });
      expect(await queue()).toEqual([]);
    },
  );
  it("rejects an approval bound to another lead", async () => {
    const unrelated = await fixture.lead("unrelated");
    await fixture.sent("wrong", { approvalLead: unrelated });
    expect(await queue()).toEqual([]);
  });
  it("rejects a rebound non-X parent", async () => {
    await fixture.sent("old");
    await fixture.sql`update noelle.agent_instances set role='linkedin_intern' where id=${profilingInstance}`;
    expect(await queue()).toEqual([]);
  });
  it("uses the confirmed send date rather than a later approval update", async () => {
    await fixture.sent("old", { sentDaysAgo: 40 });
    expect(await queue()).toEqual([]);
  });
  it("preserves strict reply threshold and the existing profile handle", async () => {
    await fixture.sent("Builder");
    await fixture.sent("builder");
    await fixture.sql`insert into noelle.x_watchlist_profiles(org_id,agent_instance_id,handle,refreshed_at)
      values (${profilingOrg},${profilingInstance},'BUILDER',now()-interval '4 days')`;
    expect(
      await listRepliedPeopleNeedingProfile(fixture.sql, {
        agentInstanceId: profilingInstance,
        minReplies: 1,
        windowDays: 30,
        staleDays: 3,
        batch: 20,
      }),
    ).toMatchObject([{ handle: "BUILDER" }]);
  });
  it("does not borrow freshness from a foreign profile row", async () => {
    await fixture.sent("builder");
    await fixture.sql`insert into noelle.x_watchlist_profiles(org_id,agent_instance_id,handle,refreshed_at)
      values (${profilingForeignOrg},${profilingInstance},'builder',now())`;
    expect(await queue()).toMatchObject([{ handle: "builder" }]);
  });
});

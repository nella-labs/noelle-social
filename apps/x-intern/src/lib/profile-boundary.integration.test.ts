import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getWatchlistProfiles,
  listWatchlistPeopleNeedingProfile,
  markProfileAttempted,
  upsertWatchlistProfile,
} from "./profiles-db.js";
import {
  openProfilingFixture,
  profilingForeignOrg,
  profilingInstance,
  profilingOrg,
} from "./profiling-fixture.js";

const url = process.env.X_PROFILING_TEST_DATABASE_URL;
describe.skipIf(!url)("profile storage current X owner on native schemas", () => {
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
    listWatchlistPeopleNeedingProfile(fixture.sql, {
      agentInstanceId: profilingInstance,
      staleDays: 3,
      batch: 10,
    });
  const write = () =>
    upsertWatchlistProfile(fixture.sql, {
      orgId: profilingOrg,
      agentInstanceId: profilingInstance,
      handle: "builder",
      summary: "Fresh profile",
      topics: ["tools"],
      tone: "plain",
      engagementNotes: "No inferred results",
      postsAnalyzed: 2,
      model: "fixture",
    });

  it("keeps legitimate watchlist reads and profile writes", async () => {
    await fixture.watch("builder");
    expect(await queue()).toMatchObject([{ handle: "builder" }]);
    await write();
    expect(await queue()).toEqual([]);
    expect(
      (await getWatchlistProfiles(fixture.sql, profilingInstance)).get("builder")?.summary,
    ).toBe("Fresh profile");
  });
  it("does not queue a foreign-org watchlist soft reference", async () => {
    await fixture.watch("builder", profilingForeignOrg);
    expect(await queue()).toEqual([]);
  });
  it("does not borrow foreign profile freshness or content", async () => {
    await fixture.watch("builder");
    await fixture.sql`insert into noelle.x_watchlist_profiles(org_id,agent_instance_id,handle,summary,refreshed_at)
      values (${profilingForeignOrg},${profilingInstance},'builder','Foreign profile',now())`;
    expect(await queue()).toMatchObject([{ handle: "builder" }]);
    expect((await getWatchlistProfiles(fixture.sql, profilingInstance)).size).toBe(0);
  });
  it.each(["org", "role"])(
    "does not write or expose profiles after parent %s rebind",
    async (field) => {
      await fixture.watch("builder");
      if (field === "org")
        await fixture.sql`update noelle.agent_instances set org_id=${profilingForeignOrg} where id=${profilingInstance}`;
      else
        await fixture.sql`update noelle.agent_instances set role='linkedin_intern' where id=${profilingInstance}`;
      await write();
      await markProfileAttempted(fixture.sql, {
        orgId: profilingOrg,
        agentInstanceId: profilingInstance,
        handle: "other",
      });
      expect(await queue()).toEqual([]);
      expect((await getWatchlistProfiles(fixture.sql, profilingInstance)).size).toBe(0);
      expect(await fixture.sql`select handle from noelle.x_watchlist_profiles`).toEqual([]);
    },
  );
  it.each(["attempt", "summary"])(
    "does not overwrite a foreign profile collision with %s",
    async (mode) => {
      await fixture.sql`insert into noelle.x_watchlist_profiles(org_id,agent_instance_id,handle,summary)
      values (${profilingForeignOrg},${profilingInstance},'builder','Foreign profile')`;
      if (mode === "summary") await write();
      else
        await markProfileAttempted(fixture.sql, {
          orgId: profilingOrg,
          agentInstanceId: profilingInstance,
          handle: "builder",
        });
      expect(
        await fixture.sql`select org_id,summary,refreshed_at from noelle.x_watchlist_profiles`,
      ).toMatchObject([
        { org_id: profilingForeignOrg, summary: "Foreign profile", refreshed_at: null },
      ]);
    },
  );
});

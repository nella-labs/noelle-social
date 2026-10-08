import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getWatchlistAuthorEngagement } from "./leads-engagement-db.js";
import { getXWatchlistAuthorEngagement } from "./x-ideation-gather-db.js";
import {
  openProfilingFixture,
  profilingForeignOrg,
  profilingInstance,
  profilingOrg,
} from "./profiling-fixture.js";

const url = process.env.X_PROFILING_TEST_DATABASE_URL;
describe.skipIf(!url)("saved X engagement on native schemas", () => {
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
  const args = {
    agentInstanceId: profilingInstance,
    windowDays: 30,
    limitAuthors: 20,
    samplePosts: 5,
    minPosts: 1,
  };
  const measured = { likes: 10, replies: 2, reposts: 3 };

  it("one malformed post cannot erase the analyst's healthy author", async () => {
    await fixture.watch("healthy");
    await fixture.watch("broken");
    await fixture.lead("healthy", measured);
    await fixture.lead("broken", { likes: "bad", replies: {}, reposts: true });
    expect(
      (await getWatchlistAuthorEngagement(fixture.sql, args)).map((a) => a.authorHandle),
    ).toEqual(["healthy"]);
  });
  it.each([null, "", "bad", {}, [], true, -1, 1.5, "NaN", "Infinity", "9007199254740992"])(
    "keeps malformed or absent count %j unknown in topic samples",
    async (likes) => {
      await fixture.watch("builder");
      await fixture.lead("builder", { likes, replies: 0, reposts: "0" });
      const authors = await getXWatchlistAuthorEngagement(fixture.sql, args);
      expect(authors).toHaveLength(1);
      expect(authors[0]).toMatchObject({
        avgEngagement: null,
        samplePosts: [{ likes: null, replies: 0, reposts: 0 }],
      });
      expect(await getWatchlistAuthorEngagement(fixture.sql, args)).toEqual([]);
    },
  );
  it("preserves real zero and valid integer string measurements", async () => {
    await fixture.watch("builder");
    await fixture.lead("builder", { likes: "0", replies: 0, reposts: "2" });
    expect(await getWatchlistAuthorEngagement(fixture.sql, args)).toMatchObject([
      { avgEngagement: 2, postCount: 1, samplePosts: [{ likes: 0, replies: 0, reposts: 2 }] },
    ]);
  });
  it("averages only complete measurements and gates analyst minimum on measured posts", async () => {
    await fixture.watch("builder");
    await fixture.lead("builder", measured);
    await fixture.lead("builder");
    expect(await getXWatchlistAuthorEngagement(fixture.sql, args)).toMatchObject([
      { avgEngagement: 15, observedPostCount: 2, measuredPostCount: 1 },
    ]);
    expect(await getWatchlistAuthorEngagement(fixture.sql, { ...args, minPosts: 2 })).toEqual([]);
  });
  it("deduplicates case and @ variants without multiplying posts", async () => {
    await fixture.watch("Builder");
    await fixture.watch("@builder");
    await fixture.lead("builder", measured);
    await fixture.lead("@BUILDER", measured);
    expect(await getWatchlistAuthorEngagement(fixture.sql, args)).toMatchObject([
      { authorHandle: "builder", postCount: 2, totalEngagement: 30 },
    ]);
    expect(await getWatchlistAuthorEngagement(fixture.sql, args)).toHaveLength(1);
  });
  it.each(["watch", "lead", "parent"])("rejects foreign or rebound %s ownership", async (part) => {
    await fixture.watch("builder", part === "watch" ? profilingForeignOrg : undefined);
    await fixture.lead("builder", measured, part === "lead" ? profilingForeignOrg : undefined);
    if (part === "parent")
      await fixture.sql`update noelle.agent_instances set role='linkedin_intern' where id=${profilingInstance}`;
    expect(await getXWatchlistAuthorEngagement(fixture.sql, args)).toEqual([]);
    expect(await getWatchlistAuthorEngagement(fixture.sql, args)).toEqual([]);
  });
  it("returns bounded text and no authors for invalid limits", async () => {
    await fixture.watch("builder");
    await fixture.lead("builder", { ...measured, text: "x".repeat(10_000) });
    expect(
      (await getXWatchlistAuthorEngagement(fixture.sql, args))[0]?.samplePosts[0]?.text.length,
    ).toBeLessThanOrEqual(800);
    expect(await getXWatchlistAuthorEngagement(fixture.sql, { ...args, limitAuthors: 0 })).toEqual(
      [],
    );
  });
  it("bounds each author to the latest 100 posts before ranking", async () => {
    await fixture.watch("builder");
    const old = await fixture.lead("builder", { likes: 100_000, replies: 0, reposts: 0 });
    await fixture.sql`update noelle.leads set created_at=now()-interval '1 day' where id=${old}`;
    for (let i = 0; i < 100; i++)
      await fixture.lead("builder", { likes: 0, replies: 0, reposts: 0 });
    const [author] = await getWatchlistAuthorEngagement(fixture.sql, {
      ...args,
      samplePosts: 1_000,
    });
    expect(author).toMatchObject({ avgEngagement: 0, postCount: 100, observedPostCount: 100 });
    expect(author?.samplePosts).toHaveLength(100);
    expect(author?.samplePosts.some((post) => post.externalId === old)).toBe(false);
  });
  it("oversized metric primitives remain unknown without returning raw payloads", async () => {
    await fixture.watch("builder");
    await fixture.lead("builder", { likes: "0".repeat(1_000), replies: 0, reposts: 0 });
    expect(await getXWatchlistAuthorEngagement(fixture.sql, args)).toMatchObject([
      { avgEngagement: null, samplePosts: [{ likes: null }] },
    ]);
  });
  it("caps normalized watched authors before reading their posts", async () => {
    await fixture.sql`insert into noelle.x_watchlist_people(org_id,agent_instance_id,handle,added_at)
      select ${profilingOrg}::uuid,${profilingInstance}::uuid,'user_'||lpad(n::text,3,'0'),
        now()-interval '1 day'+n*interval '1 second' from generate_series(1,501) n`;
    await fixture.sql`insert into noelle.leads(external_id,org_id,agent_instance_id,author_handle,payload)
      select 'bounded_author_'||n,${profilingOrg}::uuid,${profilingInstance}::uuid,'user_'||lpad(n::text,3,'0'),
        jsonb_build_object('text','A source','likes',n,'replies',0,'reposts',0) from generate_series(1,501) n`;
    const authors = await getXWatchlistAuthorEngagement(fixture.sql, {
      ...args,
      limitAuthors: 1_000,
    });
    expect(authors).toHaveLength(500);
    expect(authors.some((author) => author.authorHandle === "user_501")).toBe(false);
  });
  it("omits oversized source identifiers and URLs instead of manufacturing truncated references", async () => {
    await fixture.watch("builder");
    const invalid = await fixture.lead("builder", measured);
    await fixture.sql`update noelle.leads set external_id=${"x".repeat(129)} where id=${invalid}`;
    expect(await getXWatchlistAuthorEngagement(fixture.sql, args)).toEqual([]);
    await fixture.lead("builder", { ...measured, url: "https://x.com/" + "x".repeat(2_048) });
    expect(await getXWatchlistAuthorEngagement(fixture.sql, args)).toMatchObject([
      { samplePosts: [{ url: null }] },
    ]);
  });
});

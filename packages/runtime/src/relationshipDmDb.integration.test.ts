import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimRelationshipDmCandidates,
  hasPendingRelationshipDmRequests,
  markRelationshipDmResult,
} from "./relationshipDmDb.js";

const url = process.env.NOELLE_TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ids = {
  org: "00000000-0000-4000-8000-000000000001",
  li: "00000000-0000-4000-8000-000000000011",
  x: "00000000-0000-4000-8000-000000000012",
  other: "00000000-0000-4000-8000-000000000013",
};

describe.skipIf(!url)("relationship DM DB (integration)", () => {
  let sql: ReturnType<typeof postgres>;
  const claim = (
    platform: "linkedin" | "x",
    instanceId = platform === "x" ? ids.x : ids.li,
    limit = 5,
    includeRecurring = true,
  ) => claimRelationshipDmCandidates(sql, { orgId: ids.org, instanceId, platform, limit, includeRecurring });

  beforeAll(async () => {
    sql = postgres(url!, { max: 8, onnotice: () => {} });
    const db = (await sql<{ db: string }[]>`select current_database() as db`)[0]?.db;
    if (!db?.includes("test")) throw new Error(`refusing to truncate non-test database ${db}`);
    await sql`drop schema if exists noelle cascade`;
    await sql`create schema if not exists noelle`;
    await sql.unsafe(
      "do $$ begin if not exists (select from pg_roles where rolname = 'noelle_app') then create role noelle_app nologin; end if; end $$;",
    );
    for (const file of [
      "0001_noelle_schema.sql",
      "0005_leads_full_schema.sql",
      "0018_x_watchlist_people.sql",
      "0020_x_watchlist_profiles.sql",
      "0022_watchlist_person_objective.sql",
      "0023_persons_crm.sql",
      "0027_linkedin_watchlist_people.sql",
      "0028_linkedin_watchlist_profiles.sql",
      "0044_linkedin_discovered_people.sql",
      "0090_x_discovered_people.sql",
      "0098_relationship_dm_reservations.sql",
      "0099_relationship_dm_requests.sql",
    ])
      await sql.unsafe(readFileSync(resolve(root, "infra/cloudsql/schema", file), "utf8"));
  });

  beforeEach(async () => {
    await sql`truncate noelle.relationship_dm_reservations, noelle.approvals, noelle.drafts, noelle.leads,
      noelle.relationship_dm_requests,
      noelle.linkedin_watchlist_profiles, noelle.linkedin_watchlist_people, noelle.linkedin_discovered_people,
      noelle.x_watchlist_profiles, noelle.x_watchlist_people, noelle.x_discovered_people,
      noelle.person_social_accounts, noelle.persons, noelle.agent_instances, noelle.organizations cascade`;
    await sql`insert into noelle.organizations (id, slug, name) values (${ids.org}, 'demooperator', 'Demooperator')`;
    await sql`insert into noelle.agent_instances (id, org_id, role, display_name) values
      (${ids.li}, ${ids.org}, 'linkedin_intern', 'Lyra'), (${ids.x}, ${ids.org}, 'x_intern', 'Vega'),
      (${ids.other}, ${ids.org}, 'cmo', 'Other')`;
  });

  afterAll(async () => {
    await sql?.end();
  });

  async function addPost(
    platform: "linkedin" | "x",
    handle: string,
    instanceId: string,
    n = 1,
    authorId?: string,
    postedAt: string | null = new Date().toISOString(),
  ) {
    await sql`insert into noelle.leads (external_id, org_id, agent_instance_id, platform, author_handle, author_id, payload, status)
      values (${`${platform}-${handle}-${n}`}, ${ids.org}, ${instanceId}, ${platform}, ${handle}, ${authorId ?? null}, ${sql.json({ text: `saved post ${n} from ${handle}`, url: `https://${platform}.test/${handle}/${n}`, ...(postedAt ? { postedAt } : {}) })}, 'drafted')`;
  }

  async function addDm(handle: string, status: "pending" | "sent", authorId?: string) {
    const [lead] = await sql<
      { id: string }[]
    >`insert into noelle.leads (external_id, org_id, agent_instance_id, platform, author_handle, author_id, payload, status)
      values (${`dm-${handle}`}, ${ids.org}, ${ids.other}, 'linkedin', ${handle}, ${authorId ?? null}, ${sql.json({ text: "source" })}, 'drafted') returning id`;
    const [draft] = await sql<
      { id: string }[]
    >`insert into noelle.drafts (lead_id, org_id, payload) values (${lead!.id}, ${ids.org}, ${sql.json({ kind: "dm", body: "hey" })}) returning id`;
    await sql`insert into noelle.approvals (org_id, agent_instance_id, draft_id, lead_id, status, decided_at) values (${ids.org}, ${ids.other}, ${draft!.id}, ${lead!.id}, ${status}, now())`;
  }

  it("claims LinkedIn from stored posts, notes, URL-only CRM accounts and linked X history", async () => {
    await sql`insert into noelle.persons (id, org_id, display_name, notes) values
      ('30000000-0000-4000-8000-000000000001', ${ids.org}, 'Maya', 'Met at the AI demo night'),
      ('30000000-0000-4000-8000-000000000002', ${ids.org}, 'URL Only', 'Asked Demooperator about calm founder outreach'),
      ('30000000-0000-4000-8000-000000000003', ${ids.org}, 'Cross', null)`;
    await sql`insert into noelle.person_social_accounts (org_id, person_id, platform, handle, url) values
      (${ids.org}, '30000000-0000-4000-8000-000000000001', 'linkedin', 'maya-builds', 'https://www.linkedin.com/in/maya-builds/'),
      (${ids.org}, '30000000-0000-4000-8000-000000000002', 'linkedin', null, 'https://www.linkedin.com/in/url-only/?miniProfileUrn=x'),
      (${ids.org}, '30000000-0000-4000-8000-000000000003', 'linkedin', 'cross-li', 'https://www.linkedin.com/in/cross-li/'),
      (${ids.org}, '30000000-0000-4000-8000-000000000003', 'x', 'crossx', null)`;
    await sql`insert into noelle.linkedin_watchlist_people (org_id, agent_instance_id, fsd_profile_id, public_id, name, headline) values (${ids.org}, ${ids.li}, 'fsd1', 'maya-builds', 'Maya', 'Founder')`;
    await sql`insert into noelle.linkedin_watchlist_profiles (org_id, agent_instance_id, fsd_profile_id, public_id, summary, topics, tone, engagement_notes, posts_analyzed) values (${ids.org}, ${ids.li}, 'fsd1', 'maya-builds', 'Builds calm AI tooling', ${sql.json(["ai"] as never)}, 'warm', 'Ask about shipping', 4)`;
    await addPost("linkedin", "maya-builds", ids.li, 1, "fsd1");
    await addPost("linkedin", "url-only", ids.li, 1);
    await addPost("x", "crossx", ids.x, 1);

    const claimed = await claim("linkedin");
    expect(claimed.find((c) => c.authorHandle === "url-only")?.context[0]?.kind).toBe("note");
    expect(
      claimed
        .find((c) => c.authorHandle === "cross-li")
        ?.context.some((e) => e.id.startsWith("post:x:")),
    ).toBe(true);
    const maya = claimed.find((c) => c.authorHandle === "maya-builds");
    expect(maya).toMatchObject({
      authorId: "fsd1",
      name: "Maya",
      profileUrl: "https://www.linkedin.com/in/maya-builds/",
    });
    expect(maya!.context.map((e) => e.kind).slice(0, 3)).toEqual(
      expect.arrayContaining(["post", "note"]),
    );
    await expect(claim("linkedin")).resolves.toEqual([]);
  });

  it("requires primary evidence before reservation", async () => {
    await sql`insert into noelle.x_watchlist_people (org_id, agent_instance_id, handle) values (${ids.org}, ${ids.x}, 'thin')`;
    await sql`insert into noelle.x_watchlist_profiles (org_id, agent_instance_id, handle, summary, topics, posts_analyzed) values (${ids.org}, ${ids.x}, 'thin', 'Profile-only context should not spend the DM cap', ${sql.json([] as never)}, 1)`;
    await sql`insert into noelle.leads (external_id, org_id, agent_instance_id, platform, author_handle, payload, status) values
      ('thin:intro', ${ids.org}, ${ids.x}, 'x', 'thin', ${sql.json({ text: "synthetic intro should not count", postKind: "intro_dm" })}, 'drafted'),
      ('thin:notification', ${ids.org}, ${ids.x}, 'x', 'thin', ${sql.json({ text: "notification reply should not count", source: "notification" })}, 'drafted')`;
    expect(await claim("x", ids.x, 1)).toEqual([]);
  });

  it.each(["linkedin", "x"] as const)("does not reserve %s recipients whose newest saved post is older than 7 days", async (platform) => {
    const instanceId = platform === "x" ? ids.x : ids.li;
    const staleAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await addPost(platform, "stale", instanceId, 1, undefined, staleAt);

    await expect(claim(platform, instanceId, 1)).resolves.toEqual([]);
  });

  it.each(["linkedin", "x"] as const)("does not use %s ingestion time as an undated post timestamp", async (platform) => {
    const instanceId = platform === "x" ? ids.x : ids.li;
    await addPost(platform, "undated", instanceId, 1, undefined, null);

    await expect(claim(platform, instanceId, 1)).resolves.toEqual([]);
  });

  it("returns the newest saved posts first with their real post timestamps", async () => {
    const olderAt = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const newestAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await addPost("x", "current", ids.x, 1, undefined, olderAt);
    await addPost("x", "current", ids.x, 2, undefined, newestAt);

    const [candidate] = await claim("x", ids.x, 1);
    const posts = candidate!.context.filter((item) => item.kind === "post");
    expect(posts.map((item) => item.text)).toEqual([
      "saved post 2 from current",
      "saved post 1 from current",
    ]);
    expect(posts.map((item) => Date.parse(item.occurredAt!))).toEqual([
      Date.parse(newestAt),
      Date.parse(olderAt),
    ]);
  });

  it("requested-only mode does not claim recurring candidates directly", async () => {
    await addPost("x", "organic", ids.x, 1);
    await expect(claim("x", ids.x, 5, false)).resolves.toEqual([]);
    await expect(
      hasPendingRelationshipDmRequests(sql, { orgId: ids.org, instanceId: ids.x, platform: "x" }),
    ).resolves.toBe(false);
    const [count] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from noelle.relationship_dm_reservations`;
    expect(count?.n).toBe(0);
  });

  it("drains the oldest one-off request without recurring candidates", async () => {
    await addPost("x", "alpha", ids.x, 1);
    await addPost("x", "beta", ids.x, 1);
    await sql`insert into noelle.relationship_dm_requests
      (org_id, agent_instance_id, platform, recipient_key, requested_count, created_at)
      values (${ids.org}, ${ids.x}, 'x', 'alpha', 1, now() - interval '1 minute'),
        (${ids.org}, ${ids.x}, 'x', 'beta', 1, now())`;
    const [candidate] = await claim("x", ids.x, 5, false);
    expect(candidate).toMatchObject({ authorHandle: "alpha", requestId: expect.any(String) });
    await markRelationshipDmResult(sql, {
      orgId: ids.org,
      reservationId: candidate!.reservationId,
      status: "queued",
      judgeVerdict: { pass: true, reason: "Specific saved detail" },
    });
    await markRelationshipDmResult(sql, {
      orgId: ids.org,
      reservationId: candidate!.reservationId,

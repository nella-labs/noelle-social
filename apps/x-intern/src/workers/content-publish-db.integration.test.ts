import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createXApiClient,
  makeRefreshCoordinator,
  XWriteUncertainError,
  type XWriteClient,
} from "@noelle/x-client";
import { runContentPublishTick } from "./content-publish-tick.js";

const url = process.env.NOELLE_X_PUBLISH_CLAIMS_TEST_DATABASE_URL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const org = "00000000-0000-4000-8000-000000000001";
const foreignOrg = "00000000-0000-4000-8000-000000000002";
const instance = "00000000-0000-4000-8000-000000000011";
const foreignInstance = "00000000-0000-4000-8000-000000000012";

describe.skipIf(!url)("X publishing storage boundary (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 12, onnotice: () => {} });
    const db = (await sql<{ db: string }[]>`select current_database() as db`)[0]?.db;
    if (!db?.endsWith("_x_publish_claims_test"))
      throw new Error(`refusing to reset non-dedicated database ${db}`);
    await sql`drop schema if exists noelle cascade`;
    await sql.unsafe(
      "do $$ begin if not exists (select from pg_roles where rolname='noelle_app') then create role noelle_app nologin; end if; end $$",
    );
    for (const file of [
      "0001_noelle_schema.sql",
      "0019_worker_enabled.sql",
      "0045_post_ideas.sql",
      "0046_post_drafts.sql",
      "0057_content_media.sql",
      "0059_content_crossplatform.sql",
      "0060_post_draft_fields.sql",
      "0074_content_schedule_slots.sql",
      "0075_x_api_write.sql",
      "0079_x_self_tracking.sql",
    ])
      await sql.unsafe(readFileSync(resolve(root, "infra/cloudsql/schema", file), "utf8"));
  });
  beforeEach(async () => {
    await sql`drop trigger if exists reject_publish_receipt on noelle.content_schedule_slots`;
    await sql`drop trigger if exists reject_publish_restore on noelle.content_schedule_slots`;
    await sql`truncate noelle.content_schedule_slots, noelle.content_media, noelle.post_drafts,
      noelle.post_ideas, noelle.x_api_write_budget, noelle.agent_instances, noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${org},'one','One'),(${foreignOrg},'two','Two')`;
    await sql`insert into noelle.agent_instances(id,org_id,role,send_enabled,x_api_write_enabled)
      values (${instance},${org},'x_intern',true,true),(${foreignInstance},${foreignOrg},'x_intern',true,true)`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  async function seed(ownerOrg = org, ownerInstance = instance, platform = "x") {
    const [idea] = await sql<
      { id: string }[]
    >`insert into noelle.post_ideas(org_id,agent_instance_id,platform,hook,status)
      values (${ownerOrg},${ownerInstance},${platform},'Useful finding','ready') returning id`;
    const [draft] = await sql<
      { id: string }[]
    >`insert into noelle.post_drafts(org_id,agent_instance_id,idea_id,platform,body,status)
      values (${ownerOrg},${ownerInstance},${idea!.id},${platform},'Supported original','ready') returning id`;
    const [slot] = await sql<{ id: string }[]>`insert into noelle.content_schedule_slots
      (org_id,agent_instance_id,platform,slot_at,status,idea_id,draft_id,auto_publish)
      values (${ownerOrg},${ownerInstance},${platform},now()-interval '1 minute','ready',${idea!.id},${draft!.id},true) returning id`;
    return { ideaId: idea!.id, draftId: draft!.id, slotId: slot!.id };
  }
  function publisher(
    options: {
      beforePost?: () => Promise<void>;
      beforeUpload?: () => Promise<void>;
      uncertain?: boolean;
    } = {},
  ) {
    const posts: string[] = [];
    let uploads = 0;
    const client = {
      async uploadMedia() {
        uploads++;
        await options.beforeUpload?.();
        return { mediaId: "image" };
      },
      async postTweet({ text }: { text: string }) {
        posts.push(text);
        await options.beforePost?.();
        if (options.uncertain) throw new XWriteUncertainError("response lost");
        return { id: String(posts.length), url: `https://x.com/operator/status/${posts.length}` };
      },
    } as unknown as XWriteClient;
    const tick = () =>
      runContentPublishTick({
        sql,
        instanceId: instance,
        orgId: org,
        cap: 30,
        minSpacingMs: 60_000,
        client,
      });
    return { tick, posts, uploads: () => uploads };
  }
  async function image(
    draftId: string,
    options: { ownerOrg?: string; ownerInstance?: string; platform?: string; status?: string } = {},
  ) {
    await sql`insert into noelle.content_media(org_id,agent_instance_id,draft_id,platform,storage_key,url,mime_type,status)
      values (${options.ownerOrg ?? org},${options.ownerInstance ?? instance},${draftId},${options.platform ?? "x"},
        ${`image-${Math.random()}`},'data:image/png;base64,iVBORw==','image/png',${options.status ?? "ready"})`;
  }

  it("serializes eight concurrent due slots into one dispatch per spacing window", async () => {
    for (let i = 0; i < 8; i++) await seed();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = publisher({ beforePost: () => pending });
    const ticks = Array.from({ length: 8 }, () => p.tick());
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const [state] = await sql<
          { waiting: boolean }[]
        >`select exists(select 1 from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock') as waiting`;
        if (p.posts.length > 1 || state?.waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      release();
    }
    await Promise.all(ticks);
    expect(p.posts).toHaveLength(1);
    expect(
      await sql`select id from noelle.content_schedule_slots where status='published'`,
    ).toHaveLength(1);
    expect(
      (await sql<{ used: number }[]>`select used from noelle.x_api_write_budget`)[0]?.used,
    ).toBe(1);
  });

  it.each([
    "slot org",
    "draft org",
    "draft instance",
    "idea org",
    "idea instance",
    "slot platform",
    "draft platform",
    "dismissed draft",
    "posted draft",
  ])("does not dispatch an invalid %s soft binding", async (fault) => {
    const d = await seed();
    if (fault === "slot org")
      await sql`update noelle.content_schedule_slots set org_id=${foreignOrg} where id=${d.slotId}`;
    if (fault === "draft org")
      await sql`update noelle.post_drafts set org_id=${foreignOrg} where id=${d.draftId}`;
    if (fault === "draft instance")
      await sql`update noelle.post_drafts set agent_instance_id=${foreignInstance} where id=${d.draftId}`;
    if (fault === "idea org")
      await sql`update noelle.post_ideas set org_id=${foreignOrg} where id=${d.ideaId}`;
    if (fault === "idea instance")
      await sql`update noelle.post_ideas set agent_instance_id=${foreignInstance} where id=${d.ideaId}`;
    if (fault === "slot platform")
      await sql`update noelle.content_schedule_slots set platform='linkedin' where id=${d.slotId}`;
    if (fault === "draft platform")
      await sql`update noelle.post_drafts set platform='linkedin' where id=${d.draftId}`;
    if (fault === "dismissed draft")
      await sql`update noelle.post_drafts set status='dismissed' where id=${d.draftId}`;
    if (fault === "posted draft")
      await sql`update noelle.post_drafts set posted_url='https://x.com/operator/status/previous' where id=${d.draftId}`;
    const p = publisher();
    await p.tick();
    expect(p.posts).toHaveLength(0);
    expect(await sql`select * from noelle.x_api_write_budget`).toHaveLength(0);
  });

  it.each(["send", "API write", "inactive", "wrong org", "wrong role"])(
    "rechecks the actual %s instance gate",
    async (gate) => {
      await seed();
      if (gate === "send")
        await sql`update noelle.agent_instances set send_enabled=false where id=${instance}`;
      if (gate === "API write")
        await sql`update noelle.agent_instances set x_api_write_enabled=false where id=${instance}`;
      if (gate === "inactive")
        await sql`update noelle.agent_instances set status='archived' where id=${instance}`;
      if (gate === "wrong org") {
        await sql`insert into noelle.organizations(id,slug,name) values ('00000000-0000-4000-8000-000000000003','three','Three')`;
        await sql`update noelle.agent_instances set org_id='00000000-0000-4000-8000-000000000003' where id=${instance}`;
      }
      if (gate === "wrong role")
        await sql`update noelle.agent_instances set role='linkedin_intern' where id=${instance}`;
      const p = publisher();
      await p.tick();
      expect(p.posts).toHaveLength(0);
      expect(await sql`select * from noelle.x_api_write_budget`).toHaveLength(0);
    },
  );

  it.each(["foreign org", "foreign instance", "other platform", "uploading"])(
    "never uploads %s media attached by a soft tenant relationship",
    async (fault) => {
      const d = await seed();
      await image(d.draftId, {
        ...(fault === "foreign org" ? { ownerOrg: foreignOrg } : {}),
        ...(fault === "foreign instance" ? { ownerInstance: foreignInstance } : {}),
        ...(fault === "other platform" ? { platform: "linkedin" } : {}),
        ...(fault === "uploading" ? { status: "uploading" } : {}),
      });
      const p = publisher();
      await p.tick();
      expect(p.posts).toHaveLength(1);
      expect(p.uploads()).toBe(0);
    },
  );

  it.each(["cancelled", "rebound", "send disabled", "API disabled"])(
    "honors a committed %s change during media preparation",
    async (change) => {
      const d = await seed();
      await image(d.draftId);
      const other = change === "rebound" ? await seed() : null;
      if (other)
        await sql`update noelle.content_schedule_slots set draft_id=null,status='skipped' where id=${other.slotId}`;
      const p = publisher({
        beforeUpload: async () => {
          if (change === "cancelled")
            await sql`update noelle.content_schedule_slots set status='skipped' where id=${d.slotId}`;
          if (change === "rebound")
            await sql`update noelle.content_schedule_slots set draft_id=${other!.draftId},idea_id=${other!.ideaId} where id=${d.slotId}`;
          if (change === "send disabled")
            await sql`update noelle.agent_instances set send_enabled=false where id=${instance}`;
          if (change === "API disabled")
            await sql`update noelle.agent_instances set x_api_write_enabled=false where id=${instance}`;
        },
      });
      await p.tick();
      expect(p.posts).toHaveLength(0);
      expect(
        (await sql<{ used: number }[]>`select used from noelle.x_api_write_budget`)[0]?.used ?? 0,
      ).toBe(0);
      if (change === "cancelled")
        expect(
          (await sql`select status from noelle.content_schedule_slots where id=${d.slotId}`)[0]
            ?.status,
        ).toBe("skipped");
      if (change === "rebound")
        expect(
          (await sql`select draft_id from noelle.content_schedule_slots where id=${d.slotId}`)[0]
            ?.draft_id,
        ).toBe(other!.draftId);
    },
  );

  it("holds the instance after an ambiguous original instead of dispatching the next overdue slot", async () => {
    await seed();
    await seed();
    const p = publisher({ uncertain: true });
    expect((await p.tick())[0]?.status).toBe("uncertain");
    expect(await p.tick()).toEqual([]);
    expect(p.posts).toHaveLength(1);
    expect(
      (await sql<{ used: number }[]>`select used from noelle.x_api_write_budget`)[0]?.used,
    ).toBe(1);
  });

  it("allows native draft FK insertion while authorization holds parent locks", async () => {
    const d = await seed();
    const p = publisher({
      beforePost: async () => {
        await sql.begin(async (tx) => {
          await tx`set local lock_timeout='1s'`;
          await tx`insert into noelle.post_drafts(org_id,agent_instance_id,idea_id,platform,body)
          values (${org},${instance},${d.ideaId},'x','Next version')`;
        });
      },
    });
    expect((await p.tick())[0]?.status).toBe("published");
    expect(await sql`select id from noelle.post_drafts where idea_id=${d.ideaId}`).toHaveLength(2);
  });

  it("refreshes and persists a real coordinated token with only two pool connections during dispatch", async () => {
    await seed();
    await sql`insert into noelle.x_api_tokens(org_id,agent_instance_id,access_token,refresh_token,access_token_expires_at)
      values (${org},${instance},'expired-fixture','fixture-refresh',now()-interval '1 minute')`;
    const smallPool = postgres(url!, { max: 2, onnotice: () => {} });
    const calls: string[] = [];
    try {
      const client = createXApiClient({
        role: "x_intern",
        sendEnabled: true,
        xApiWriteEnabled: true,
        handle: "operator",
        tokens: { accessToken: "expired-fixture", refreshToken: "fixture-refresh", expiresAt: 1 },
        clientId: "fixture-client",
        refreshCoordinator: makeRefreshCoordinator(smallPool, instance),
        onTokensRefreshed: async (t) => {
          await smallPool`update noelle.x_api_tokens set access_token=${t.accessToken} where agent_instance_id=${instance}`;
        },
        fetchFn: (async (input) => {
          const target = String(input);
          calls.push(target);
          return new Response(
            JSON.stringify(
              target.includes("/oauth2/token")
                ? {
                    access_token: "rotated-fixture",
                    refresh_token: "next-fixture",
                    expires_in: 7200,
                  }
                : { data: { id: "123" } },
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as typeof fetch,
      });
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          runContentPublishTick({
            sql: smallPool,
            instanceId: instance,
            orgId: org,
            cap: 30,
            minSpacingMs: 60_000,
            client,
          }),
        ),
      );
      expect(outcomes.flat().filter((outcome) => outcome.status === "published")).toHaveLength(1);
      expect(calls.filter((target) => target.includes("/oauth2/token"))).toHaveLength(1);
      expect(calls.filter((target) => target.endsWith("/tweets"))).toHaveLength(1);
      expect(
        (
          await sql`select access_token from noelle.x_api_tokens where agent_instance_id=${instance}`
        )[0]?.access_token,
      ).toBe("rotated-fixture");
    } finally {
      await smallPool.end();
    }
  });

  it("retains a confirmed receipt when the final publish transaction fails at commit", async () => {
    const d = await seed();
    await sql.unsafe(`create or replace function noelle.reject_publish_receipt_fixture() returns trigger language plpgsql as $$
      begin raise exception 'fixture receipt commit failed'; end $$`);
    await sql.unsafe(`create constraint trigger reject_publish_receipt after update on noelle.content_schedule_slots
      deferrable initially deferred for each row when (new.status='published') execute function noelle.reject_publish_receipt_fixture()`);
    const p = publisher();
    expect((await p.tick())[0]).toMatchObject({
      status: "uncertain",
      reconciliationPersisted: true,
      receipt: { id: "1", url: "https://x.com/operator/status/1" },
    });
    expect(
      (
        await sql`select status,posted_tweet_id from noelle.content_schedule_slots where id=${d.slotId}`
      )[0],
    ).toEqual({ status: "failed", posted_tweet_id: "1" });
    expect(await p.tick()).toEqual([]);
    expect(p.posts).toHaveLength(1);
    expect(
      (await sql<{ used: number }[]>`select used from noelle.x_api_write_budget`)[0]?.used,
    ).toBe(1);
  });

  it("uses a final edit committed during media preparation as the actual post body", async () => {
    const d = await seed();
    await image(d.draftId);
    const p = publisher({
      beforeUpload: async () => {
        await sql`update noelle.post_drafts set final_body='Reviewed latest original' where id=${d.draftId}`;
      },
    });
    expect((await p.tick())[0]?.status).toBe("published");
    expect(p.posts).toEqual(["Reviewed latest original"]);
  });

  it("refunds a cancelled dispatch once when restoring its durable claim fails", async () => {
    const d = await seed();
    await image(d.draftId);
    await sql`insert into noelle.x_api_write_budget(org_id,agent_instance_id,day,used)
      values (${org},${instance},${new Date().toISOString().slice(0, 10)}::date,3)`;
    await sql.unsafe(`create or replace function noelle.reject_publish_restore_fixture() returns trigger language plpgsql as $$
      begin raise exception 'fixture restore failed'; end $$`);
    await sql.unsafe(`create trigger reject_publish_restore before update on noelle.content_schedule_slots
      for each row when (new.status='ready') execute function noelle.reject_publish_restore_fixture()`);
    const p = publisher({
      beforeUpload: async () => {
        await sql`update noelle.agent_instances set send_enabled=false where id=${instance}`;
      },
    });
    expect((await p.tick())[0]).toMatchObject({ status: "cancelled", claimRetained: true });
    expect(p.posts).toHaveLength(0);
    expect(
      (await sql`select status from noelle.content_schedule_slots where id=${d.slotId}`)[0]?.status,
    ).toBe("publishing");

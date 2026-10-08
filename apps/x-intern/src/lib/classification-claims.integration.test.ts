import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "./leads-db.js";

const url = process.env.X_CLASSIFICATION_DATABASE_URL;
const orgId = "00000000-0000-4000-8000-000000000001";
const foreignOrg = "00000000-0000-4000-8000-000000000002";
const instance = "00000000-0000-4000-8000-000000000011";
const foreignInstance = "00000000-0000-4000-8000-000000000012";
type Claim = db.ClassificationClaim;
const release = db.releaseClassificationClaims;

describe.skipIf(!url)("X classification claim admission release (native)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, {
      max: 4,
      onnotice: () => {},
      connection: { application_name: "classifier-release-native" },
    });
    const [database] = await sql`select current_database() as name`;
    if (!database?.name.endsWith("_x_classification_test")) {
      await sql.end();
      throw new Error("Dedicated X classification database required");
    }
    await sql`drop schema if exists noelle cascade`;
    for (const file of [
      "0001_noelle_schema.sql",
      "0005_leads_full_schema.sql",
      "0018_x_watchlist_people.sql",
    ]) {
      await sql.unsafe(
        await readFile(
          new URL(`../../../../infra/cloudsql/schema/${file}`, import.meta.url),
          "utf8",
        ),
      );
    }
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${orgId},'one','One'),(${foreignOrg},'two','Two')`;
    await sql`insert into noelle.agent_instances(id,org_id,role) values
      (${instance},${orgId},'x_intern'),(${foreignInstance},${foreignOrg},'x_intern')`;
  });
  afterAll(async () => {
    await sql?.end();
    const inspector = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      await vi.waitFor(
        async () => {
          const [row] = await inspector`select count(*)::int as remaining from pg_stat_activity
          where datname=current_database() and application_name='classifier-release-native'
            and backend_type='client backend'`;
          expect(row?.remaining).toBe(0);
        },
        { timeout: 5000, interval: 50 },
      );
    } finally {
      await inspector.end();
    }
  });
  async function seed(
    options: { org?: string; owner?: string; platform?: string; status?: string } = {},
  ) {
    const id = randomUUID();
    await sql`insert into noelle.leads(id,external_id,org_id,agent_instance_id,platform,status,payload)
      values (${id},${id},${options.org ?? orgId},${options.owner ?? instance},${options.platform ?? "x"},
        ${options.status ?? "new"},'{"text":"A real source post"}')`;
    return id;
  }
  async function claim() {
    return (
      await db.claimLeadsForClassification(sql, { orgId, agentInstanceId: instance, batch: 10 })
    )[0] as Claim;
  }
  const releaseOne = (row: Claim, scope = { orgId, agentInstanceId: instance }) => {
    expect(release).toBeTypeOf("function");
    return release(sql, { ...scope, claims: [row] });
  };
  async function stored(id: string) {
    return (
      await sql`select status,payload,updated_at::text as lease from noelle.leads where id=${id}`
    )[0]!;
  }

  it("returns the exact database claim lease instead of a rounded JS date", async () => {
    const id = await seed();
    const row = await claim();
    expect(row.classification_claimed_at).toBeTypeOf("string");
    expect(row.classification_claimed_at).toBe((await stored(id)).lease);
  });
  it("releases an unchanged valid claim and preserves its source payload", async () => {
    const id = await seed();
    const row = await claim();
    expect(await releaseOne(row)).toBe(1);
    expect(await stored(id)).toMatchObject({
      status: "new",
      payload: { text: "A real source post" },
    });
    expect(await releaseOne(row)).toBe(0);
  });
  it.each(["classified", "drafting", "skipped"])(
    "cannot reset an intervening %s state",
    async (status) => {
      const id = await seed();
      const row = await claim();
      await sql`update noelle.leads set status=${status} where id=${id}`;
      expect(await releaseOne(row)).toBe(0);
      expect((await stored(id)).status).toBe(status);
    },
  );
  it("cannot reset a same-status row changed after the claim", async () => {
    const id = await seed();
    const row = await claim();
    await sql`update noelle.leads set payload=payload || '{"new_evidence":true}' where id=${id}`;
    expect(await releaseOne(row)).toBe(0);
    expect((await stored(id)).payload.new_evidence).toBe(true);
  });
  it("rejects an old lease after requeue/reclaim but accepts the new lease", async () => {
    await seed();
    const old = await claim();
    await sql`update noelle.leads set status='new' where id=${old.id}`;
    const current = await claim();
    expect(current.classification_claimed_at).not.toBe(old.classification_claimed_at);
    expect(await releaseOne(old)).toBe(0);
    expect(await releaseOne(current)).toBe(1);
  });
  it("rejects foreign scope, soft org mismatch and another platform", async () => {
    await seed();
    const row = await claim();
    expect(await releaseOne(row, { orgId: foreignOrg, agentInstanceId: instance })).toBe(0);
    expect(await releaseOne(row, { orgId, agentInstanceId: foreignInstance })).toBe(0);
    const foreign = await seed({ org: foreignOrg, status: "classifying" });
    const otherPlatform = await seed({ platform: "linkedin", status: "classifying" });
    for (const id of [foreign, otherPlatform]) {
      expect(
        await releaseOne({ ...row, id, classification_claimed_at: (await stored(id)).lease }),
      ).toBe(0);
      expect((await stored(id)).status).toBe("classifying");
    }
  });
  it.each(["role", "org"])(
    "rechecks %s after waiting for the current parent lock",
    async (kind) => {
      await seed();
      const row = await claim();
      expect(release).toBeTypeOf("function");
      if (kind === "org")
        await sql`update noelle.agent_instances set role='other' where id=${foreignInstance}`;
      let unlock!: () => void;
      let locked!: () => void;
      const gate = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const writer = sql.begin(async (tx) => {
        await tx`select id from noelle.agent_instances where id=${instance} for no key update`;
        if (kind === "role")
          await tx`update noelle.agent_instances set role='linkedin_intern' where id=${instance}`;
        else await tx`update noelle.agent_instances set org_id=${foreignOrg} where id=${instance}`;
        locked();
        await gate;
      });
      await acquired;
      let settled = false;
      const releasing = releaseOne(row).then((result) => {
        settled = true;
        return result;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(settled).toBe(false);
      } finally {
        unlock();
        await writer;
      }
      expect(await releasing).toBe(0);
      expect((await stored(row.id)).status).toBe("classifying");
    },
  );
  it("bounds the release batch and treats empty input as no work", async () => {
    await seed();
    const row = await claim();
    expect(release).toBeTypeOf("function");
    expect(await release(sql, { orgId, agentInstanceId: instance, claims: [] })).toBe(0);
    expect(
      await release(sql, { orgId, agentInstanceId: instance, claims: Array(11).fill(row) }),
    ).toBe(0);
    expect((await stored(row.id)).status).toBe("classifying");
  });
  it("times out a held parent lock without a late reset and recovers independently", async () => {
    await seed();
    const row = await claim();
    let unlock!: () => void;
    let locked!: () => void;

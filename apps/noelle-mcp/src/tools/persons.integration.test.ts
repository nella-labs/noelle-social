import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NoelleContext } from "../context.js";
import { personsModule } from "./persons.js";

const url = process.env.NOELLE_PERSON_MCP_TEST_DATABASE_URL;
const orgId = "00000000-0000-4000-8000-000000000001";
describe.skipIf(!url)("initial person/account creation (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>, ctx: NoelleContext;
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    const [db] = await sql`select current_database() as name`;
    if (!db?.name.endsWith("_person_mcp_test")) {
      await sql.end();
      throw new Error("Dedicated person MCP test database required");
    }
    await sql`drop schema if exists noelle cascade`;
    for (const file of [
      "0001_noelle_schema.sql",
      "0005_leads_full_schema.sql",
      "0018_x_watchlist_people.sql",
      "0023_persons_crm.sql",
    ])
      await sql.unsafe(
        await readFile(
          new URL(`../../../../infra/cloudsql/schema/${file}`, import.meta.url),
          "utf8",
        ),
      );
    ctx = {
      sql,
      assertWritable: () => {},
      resolveOrg: async () => ({ orgId, slug: "one", name: "One" }),
    } as unknown as NoelleContext;
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${orgId},'one','One')`;
  });
  afterAll(async () => {
    await sql?.end();
  });
  const call = (account: Record<string, unknown> = {}) =>
    personsModule.handle("noelle_add_person", { displayName: "Ada", ...account }, ctx);

  it.each([
    { platform: "unsupported", handle: "ada" },
    { platform: "unsupported" },
    { platform: "x" },
    { handle: "ada" },
  ])("refuses %j without creating a person", async (account) => {
    expect(await call(account)).toMatchObject({ isError: true });
    expect(await sql`select id from noelle.persons`).toHaveLength(0);
  });

  it("rolls back the new person when the account conflicts with an existing handle", async () => {
    expect(await call({ platform: "x", handle: "ada" })).not.toMatchObject({ isError: true });
    expect(await call({ displayName: "Other Ada", platform: "x", handle: "ADA" })).toMatchObject({
      isError: true,
    });
    expect(await sql`select display_name from noelle.persons`).toEqual([{ display_name: "Ada" }]);
    expect(await sql`select handle from noelle.person_social_accounts`).toEqual([
      { handle: "ada" },
    ]);
  });

  it.each(["x", "linkedin", "reddit"])(
    "commits one coherent %s account with its new person",
    async (platform) => {
      expect(await call({ platform, handle: "ada" })).not.toMatchObject({ isError: true });
      expect(
        await sql`select p.display_name,a.platform,a.handle from noelle.persons p
      join noelle.person_social_accounts a on a.person_id=p.id and a.org_id=p.org_id where p.org_id=${orgId}`,
      ).toEqual([{ display_name: "Ada", platform, handle: "ada" }]);
    },
  );

  it("keeps account-free creation supported", async () => {
    expect(await call()).not.toMatchObject({ isError: true });
    expect(await sql`select display_name from noelle.persons`).toEqual([{ display_name: "Ada" }]);
    expect(await sql`select id from noelle.person_social_accounts`).toHaveLength(0);
  });
});

import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CapStatusSchema } from "@noelle/contracts";
import { resolveActiveXInternInstance } from "../lib/auth.js";
import { noelleDb } from "../lib/db.js";
import { drafterCap } from "./cap-status.js";

vi.mock("../lib/auth.js", () => ({
  resolveActiveXInternInstance: vi.fn(),
  isOrgMember: vi.fn(),
}));
vi.mock("../lib/db.js", () => ({ noelleDb: vi.fn() }));

const org = "11111111-1111-4111-8111-111111111111";
const foreignOrg = "22222222-2222-4222-8222-222222222222";
const instances = {
  x: "33333333-3333-4333-8333-333333333333",
  linkedin: "44444444-4444-4444-8444-444444444444",
  reddit: "55555555-5555-4555-8555-555555555555",
  foreignX: "66666666-6666-4666-8666-666666666666",
};
const url = process.env.NOELLE_TEST_DATABASE_URL;
const defaults = {
  x: { active: 0, cap: 500, full: false },
  linkedin: { active: 0, cap: 100, full: false },
  reddit: { active: 0, cap: 100, full: false },
};

async function readStatus() {
  return drafterCap.request("/api/outbound/cap-status");
}

beforeEach(() => {
  vi.mocked(resolveActiveXInternInstance).mockReset().mockResolvedValue({
    org_id: org, agent_instance_id: instances.x,
  });
  vi.mocked(noelleDb).mockReset();
});

describe("outbound cap report", () => {
  it("returns default empty counts without an active X owner", async () => {
    vi.mocked(resolveActiveXInternInstance).mockResolvedValue(null);
    const response = await readStatus();
    expect(response.status).toBe(200);
    expect(CapStatusSchema.parse(await response.json())).toEqual(defaults);
    expect(noelleDb).not.toHaveBeenCalled();
  });

  it("retains the database read failure response", async () => {
    vi.mocked(noelleDb).mockReturnValue(
      vi.fn(async () => { throw new Error("test read failed"); }) as unknown as ReturnType<typeof noelleDb>,
    );
    const response = await readStatus();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "cap_status_failed", detail: "test read failed" });
  });
});

describe.skipIf(!url)("outbound cap attribution (Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    const [database] = await sql<{ name: string }[]>`select current_database() as name`;
    if (!database?.name.includes("test")) throw new Error("Cap attribution requires a test database");
  });
  beforeEach(async () => {
    await sql`begin`;
    await sql`drop schema if exists noelle cascade`;
    for (const migration of ["0001_noelle_schema.sql", "0005_leads_full_schema.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${migration}`, import.meta.url), "utf8"));
    }
    await sql`insert into noelle.organizations (id, slug, name) values
      (${org}, 'cap-test', 'Cap test'), (${foreignOrg}, 'foreign-cap-test', 'Foreign cap test')`;
    await sql`insert into noelle.agent_instances (id, org_id, role) values
      (${instances.x}, ${org}, 'x_intern'), (${instances.linkedin}, ${org}, 'linkedin_intern'),
      (${instances.reddit}, ${org}, 'reddit_intern'), (${instances.foreignX}, ${foreignOrg}, 'x_intern')`;
    vi.mocked(noelleDb).mockReturnValue(sql);
  });
  afterEach(async () => { await sql`rollback`; });
  afterAll(async () => { await sql?.end(); });

  async function add(
    externalId: string,
    platform: "x" | "linkedin" | "reddit" = "x",
    options: {
      approvalOrg?: string; approvalInstance?: string; leadOrg?: string;
      leadInstance?: string; draftOrg?: string; draftLead?: string; status?: string;
    } = {},
  ) {
    const instance = instances[platform];
    const id = randomUUID();
    const draftId = randomUUID();
    await sql`insert into noelle.leads (id, external_id, org_id, agent_instance_id, platform, payload)
      values (${id}, ${externalId}, ${options.leadOrg ?? org}, ${options.leadInstance ?? instance}, ${platform}, '{}')`;
    await sql`insert into noelle.drafts (id, org_id, lead_id, payload)
      values (${draftId}, ${options.draftOrg ?? org}, ${options.draftLead ?? id}, '{}')`;
    await sql`insert into noelle.approvals (id, org_id, agent_instance_id, lead_id, draft_id, status)
      values (${randomUUID()}, ${options.approvalOrg ?? org}, ${options.approvalInstance ?? instance},
        ${id}, ${draftId}, ${options.status ?? "pending"})`;
    return id;
  }

  it("counts pending approval rows by native platform, including multiple variants of one lead", async () => {
    const xLead = await add("x-lead");
    const secondDraft = randomUUID();
    await sql`insert into noelle.drafts (id, org_id, lead_id, payload)
      values (${secondDraft}, ${org}, ${xLead}, '{}')`;
    await sql`insert into noelle.approvals (org_id, agent_instance_id, lead_id, draft_id)
      values (${org}, ${instances.x}, ${xLead}, ${secondDraft})`;
    await add("linkedin-lead", "linkedin");
    await add("reddit-lead", "reddit");
    await add("sent-lead", "x", { status: "sent" });
    const response = await readStatus();
    expect(response.status).toBe(200);
    expect(CapStatusSchema.parse(await response.json())).toEqual({
      x: { active: 2, cap: 500, full: false },
      linkedin: { active: 1, cap: 100, full: false },
      reddit: { active: 1, cap: 100, full: false },
    });
  });

  it("excludes foreign or mismatched soft references and keeps the native instance", async () => {
    const valid = await add("valid");
    await add("foreign-approval", "x", { approvalOrg: foreignOrg });
    await add("foreign-instance", "x", { approvalInstance: instances.foreignX, leadInstance: instances.foreignX });
    await add("foreign-lead", "x", { leadOrg: foreignOrg });
    await add("other-lead-instance", "x", { leadInstance: instances.linkedin });
    await add("foreign-draft", "x", { draftOrg: foreignOrg });
    await add("other-draft-lead", "x", { draftLead: valid });
    await add("wrong-role", "linkedin", { approvalInstance: instances.x, leadInstance: instances.x });
    const response = await readStatus();
    expect(CapStatusSchema.parse(await response.json())).toEqual({
      ...defaults, x: { active: 1, cap: 500, full: false },
    });
  });
});

import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import https from "node:https";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
const fixture = vi.hoisted(() => ({ sql: null as unknown as Sql, revalidate: vi.fn(), cloud: vi.fn() }));
const org = "00000000-0000-4000-8000-000000000001", foreign = "00000000-0000-4000-8000-000000000002";
const ownCmo = "00000000-0000-4000-8000-000000000011", foreignCmo = "00000000-0000-4000-8000-000000000021", user = "00000000-0000-4000-8000-000000000099";
vi.mock("@/lib/db", () => ({ sql: new Proxy(() => {}, {
  apply: (_target, receiver, args) => Reflect.apply(fixture.sql, receiver, args),
  get: (_target, property) => { const value = Reflect.get(fixture.sql, property); return typeof value === "function" ? value.bind(fixture.sql) : value; },
}), pgOrgMembersClient: () => (query: string, params: unknown[]) => fixture.sql.unsafe(query, params as Parameters<Sql["unsafe"]>[1]) }));
vi.mock("@/lib/auth-cookie", () => ({ getUserFromCookies: async () => ({ id: user }) }));
vi.mock("@/lib/queries", async () => {
  const { assertOrgMember } = await import("@noelle/runtime");
  return { getCurrentUser: async () => ({ id: user }), getOrgBySlug: async (slug: string) => {
    const [row] = await fixture.sql`select id,slug,name from noelle.organizations where slug=${slug}`;
    if (row) await assertOrgMember((query, params) => fixture.sql.unsafe(query, [...params] as Parameters<Sql["unsafe"]>[1]), user, row.id);
    return row ?? null;
  } };
});
vi.mock("next/cache", () => ({ revalidatePath: fixture.revalidate }));
vi.mock("@noelle/runtime/vault-storage", async (original) => ({ ...await original<typeof import("@noelle/runtime/vault-storage")>(), createGcsStorage: async () => ({}), createVaultStorage: () => ({
  listPage: async (scope: { prefix: string }) => { fixture.cloud(scope); return { files: [{ path: `${scope.prefix}cloud.md`, size: 12, updatedISO: "2026-10-05T00:00:00Z" }], nextPageToken: null }; },
  readText: async (scope: { prefix: string }) => { fixture.cloud(scope); return `Scoped cloud text ${scope.prefix}`; },
}) }));
import { listVaultFilesForOrg, resolveLocalVaultRootForOrg } from "./vault";
import { applyVaultEdit } from "./agent-vault";
import { bindVaultEdit } from "./agent-chat/proposal";
import { prepareVaultSnapshot } from "./vault-snapshot";
import { GET } from "../app/api/vault/file/route";
const url = process.env.NOELLE_VAULT_CONTEXT_TEST_DATABASE_URL;
const repo = resolve(import.meta.dirname, "../../../..");
describe.skipIf(!url)("local vault binding with native memberships and storage rows", () => {
  let sql: Sql, dir = "", alternate = "";
  beforeAll(async () => {
    sql = postgres(url!, { max: 3, onnotice: () => {} });
    expect((await sql`select current_database() as db`)[0]?.db).toBe("noelle_vault_context_test");
    fixture.sql = sql; await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0006_vaults.sql", "0064_agent_chat_history.sql"])
      await sql.unsafe(readFileSync(resolve(repo, "infra/cloudsql/schema", name), "utf8"));
    dir = await mkdtemp(join(tmpdir(), "noelle-vault-binding-"));
    alternate = await mkdtemp(join(tmpdir(), "noelle-vault-alternate-"));
  });
  beforeEach(async () => {
    vi.spyOn(http, "request").mockImplementation(() => { throw new Error("HTTP forbidden in native vault tests"); });
    vi.spyOn(https, "request").mockImplementation(() => { throw new Error("HTTPS forbidden in native vault tests"); });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Fetch forbidden in native vault tests"); }));
    fixture.revalidate.mockReset(); fixture.cloud.mockReset();
    vi.stubEnv("NOELLE_VAULT_DIR", dir); vi.stubEnv("NOELLE_LOCAL_ORG_SLUG", "fixture"); vi.stubEnv("NOELLE_AUTH_MODE", "local");
    await writeFile(join(dir, "voice-spec.md"), "Private local voice rules");
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${org},'fixture','Fixture'),(${foreign},'foreign','Foreign')`;
    await sql`insert into noelle.org_members(org_id,user_id) values (${org},${user}),(${foreign},${user})`;
    await sql`insert into noelle.agent_instances(id,org_id,role) values (${ownCmo},${org},'cmo'),(${foreignCmo},${foreign},'cmo')`;
    await sql`insert into noelle.vaults(org_id,nella_workspace_id,storage_prefix) values (${org},'fixture','fixture/'),(${foreign},'foreign','foreign/')`;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(async () => { vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }); if (alternate) await rm(alternate, { recursive: true, force: true }); await sql?.end(); });
  const file = (orgId: string) => GET(new Request(`http://localhost/api/vault/file?orgId=${orgId}&path=voice-spec.md`));
  const edit = async (orgSlug: string, instanceId: string, content = "Confirmed local edit") => {
    const [inst] = await sql`select org_id,role from noelle.agent_instances where id=${instanceId}`;
    const stored = bindVaultEdit({ path: "voice-spec.md", content, summary: "Fixture edit" }, await prepareVaultSnapshot(dir), inst!.role);
    const [row] = await sql`insert into noelle.agent_chat_messages(org_id,agent_instance_id,user_id,conversation_id,role,body,vault_edit)
      values(${inst!.org_id},${instanceId},${user},gen_random_uuid(),'agent','Review it.',${sql.json(stored as never)}) returning id`;
    return applyVaultEdit({ orgSlug, instanceId, messageId: row!.id });
  };
  test("the configured local tenant keeps its native scoped file listing", async () => {
    expect((await listVaultFilesForOrg(org)).files.map((row) => row.path)).toEqual(["fixture/voice-spec.md"]);
    expect(fixture.cloud).not.toHaveBeenCalled();
  });
  test("another authorized tenant lists its own cloud prefix instead of relabeling local files", async () => {
    expect((await listVaultFilesForOrg(foreign)).files.map((row) => row.path)).toEqual(["foreign/cloud.md"]);
    expect(fixture.cloud).toHaveBeenCalledWith({ bucket: "noelle-vaults", prefix: "foreign/", limit: 50 });
  });
  test("the configured local tenant can read its own actual fixture content", async () => {
    const response = await file(org); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "voice-spec.md", body: "Private local voice rules" });
  });
  test("an existing oversized local file returns an explicit bounded-preview response", async () => {
    await writeFile(join(dir, "voice-spec.md"), "x".repeat(4 * 1024 * 1024 + 1));
    const response = await file(org);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too_large", message: "This file is too large to preview. Open it in your vault editor." });
  });
  test("another authorized tenant cannot read the configured local tenant's bytes", async () => {
    const response = await file(foreign); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "voice-spec.md", body: "Scoped cloud text foreign/" });
  });
  test("the local tenant's confirmed edit writes only its actual local file", async () => {
    expect(await edit("fixture", ownCmo)).toEqual({ ok: true, path: "voice-spec.md" });
    expect(await readFile(join(dir, "voice-spec.md"), "utf8")).toBe("Confirmed local edit");
  });
  test("another authorized tenant cannot overwrite the configured local tenant's file", async () => {
    const result = await edit("foreign", foreignCmo, "Foreign tenant edit");
    expect(result.ok).toBe(false); expect(fixture.revalidate).not.toHaveBeenCalled();
    expect(await readFile(join(dir, "voice-spec.md"), "utf8")).toBe("Private local voice rules");
  });

  test("managed auth requires an explicit local tenant binding", async () => {
    vi.stubEnv("NOELLE_AUTH_MODE", "supabase"); vi.stubEnv("NOELLE_LOCAL_ORG_SLUG", "");
    expect(await resolveLocalVaultRootForOrg(org)).toBeNull();
    expect((await listVaultFilesForOrg(org)).files.map((row) => row.path)).toEqual(["fixture/cloud.md"]);
    expect((await edit("fixture", ownCmo)).ok).toBe(false);
  });
  test("an explicit managed binding preserves owned local files", async () => {
    vi.stubEnv("NOELLE_AUTH_MODE", "supabase");
    expect(await resolveLocalVaultRootForOrg(org)).toBe(await realpath(dir));
    expect((await listVaultFilesForOrg(org)).files.map((row) => row.path)).toEqual(["fixture/voice-spec.md"]);
  });
  test("the local legacy default matches only the actual seeded organization", async () => {
    await sql`update noelle.organizations set slug='operator' where id=${org}`;
    vi.stubEnv("NOELLE_LOCAL_ORG_SLUG", "");
    expect(await resolveLocalVaultRootForOrg(org)).toBe(await realpath(dir));
    expect(await resolveLocalVaultRootForOrg(foreign)).toBeNull();
  });
  test("root and slug changes are resolved afresh for the next operation", async () => {
    expect(await resolveLocalVaultRootForOrg(org)).toBe(await realpath(dir));
    await writeFile(join(alternate, "voice-spec.md"), "Alternate local rules");
    vi.stubEnv("NOELLE_VAULT_DIR", alternate); vi.stubEnv("NOELLE_LOCAL_ORG_SLUG", "foreign");
    expect(await resolveLocalVaultRootForOrg(org)).toBeNull();
    expect(await resolveLocalVaultRootForOrg(foreign)).toBe(await realpath(alternate));
    expect(await (await file(foreign)).json()).toEqual({ path: "voice-spec.md", body: "Alternate local rules" });
  });
  test("a wrong slug or missing configured root retains the owned cloud fallback", async () => {
    vi.stubEnv("NOELLE_LOCAL_ORG_SLUG", "not-this-organization");
    expect(await resolveLocalVaultRootForOrg(org)).toBeNull();
    expect(await (await file(org)).json()).toEqual({ path: "voice-spec.md", body: "Scoped cloud text fixture/" });
    vi.stubEnv("NOELLE_LOCAL_ORG_SLUG", "fixture"); vi.stubEnv("NOELLE_VAULT_DIR", join(dir, "missing-root"));
    expect((await listVaultFilesForOrg(org)).files.map((row) => row.path)).toEqual(["fixture/cloud.md"]);
  });

});

import http from "node:http";
import https from "node:https";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ user: true, member: true, bound: true, vault: true, listPage: vi.fn(), list: vi.fn(), queries: vi.fn() }));
const org = "11111111-1111-4111-8111-111111111111";
const user = "22222222-2222-4222-8222-222222222222";
vi.mock("@/lib/db", () => ({
  pgOrgMembersClient: () => async () => fixture.member ? [{ user_id: user }] : [],
  sql: async (parts: TemplateStringsArray) => {
    const query = parts.join("?"); fixture.queries(query);
    if (query.includes("noelle.organizations")) return fixture.bound ? [{ id: org }] : [];
    if (query.includes("noelle.vaults")) return fixture.vault ? [{ storage_bucket: "fixture-bucket", storage_prefix: "fixture/" }] : [];
    throw new Error("Unexpected inert SQL query");
  },
}));
vi.mock("@/lib/auth-cookie", () => ({ getUserFromCookies: async () => fixture.user ? { id: user } : null }));
vi.mock("@noelle/runtime/vault-storage", async (original) => ({
  ...await original<typeof import("@noelle/runtime/vault-storage")>(),
  createGcsStorage: async () => ({}),
  createVaultStorage: () => ({ list: fixture.list, listPage: fixture.listPage }),
}));
import { listVaultFilesForOrg } from "./vault";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "noelle-vault-pages-"));
  for (let i = 0; i < 201; i++) await writeFile(join(dir, `file-${String(i).padStart(3, "0")}.md`), "Current fixture text.");
});
beforeEach(() => {
  fixture.user = true; fixture.member = true; fixture.bound = true; fixture.vault = true;
  fixture.listPage.mockReset(); fixture.list.mockReset(); fixture.queries.mockReset();
  fixture.listPage.mockResolvedValue({ files: [{ path: "fixture/cloud.md", size: 12, updatedISO: "2026-10-05T00:00:00Z" }], nextPageToken: "provider+/next=" });
  fixture.list.mockRejectedValue(new Error("Complete listing forbidden"));
  vi.stubEnv("NOELLE_AUTH_MODE", "local"); vi.stubEnv("NOELLE_LOCAL_ORG_SLUG", "fixture"); vi.stubEnv("NOELLE_VAULT_DIR", dir);
  vi.spyOn(http, "request").mockImplementation(() => { throw new Error("HTTP forbidden in listing tests"); });
  vi.spyOn(https, "request").mockImplementation(() => { throw new Error("HTTPS forbidden in listing tests"); });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Fetch forbidden in listing tests"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

test("local pages retain partial scan status and advance only over the bounded captured subset", async () => {
  const first = await listVaultFilesForOrg(org);
  expect(first).toMatchObject({ status: "ready", source: "local", partial: true, nextPageToken: "local1:50" });
  expect(first.files).toHaveLength(50);
  const second = await listVaultFilesForOrg(org, { pageToken: first.nextPageToken! });
  expect(second.files).toHaveLength(50);
  expect(second.files[0]?.path).not.toBe(first.files[0]?.path);
  const last = await listVaultFilesForOrg(org, { pageToken: "local1:150" });
  expect(last).toMatchObject({ partial: true, nextPageToken: null });
  expect(last.files).toHaveLength(50);
  expect(fixture.listPage).not.toHaveBeenCalled();
});
test("cloud pages preserve provider cursors and scoped bucket without complete-list work", async () => {
  fixture.bound = false;
  const first = await listVaultFilesForOrg(org, { limit: 2 });
  expect(first).toMatchObject({ status: "ready", source: "cloud", partial: false, nextPageToken: "cloud1:provider+/next=" });
  expect(fixture.listPage).toHaveBeenCalledWith({ bucket: "fixture-bucket", prefix: "fixture/", limit: 2 });
  await listVaultFilesForOrg(org, { limit: 2, pageToken: first.nextPageToken! });
  expect(fixture.listPage).toHaveBeenLastCalledWith({ bucket: "fixture-bucket", prefix: "fixture/", limit: 2, pageToken: "provider+/next=" });
  expect(fixture.list).not.toHaveBeenCalled();
});
test("an empty cloud page with continuation remains an available page", async () => {
  fixture.bound = false; fixture.listPage.mockResolvedValue({ files: [], nextPageToken: "next" });
  expect(await listVaultFilesForOrg(org)).toMatchObject({ status: "ready", files: [], nextPageToken: "cloud1:next" });
});
test("unprovisioned and unavailable results differ from an empty ready page", async () => {
  fixture.vault = false;
  expect(await listVaultFilesForOrg(org)).toMatchObject({ status: "unprovisioned", source: null, files: [] });
  fixture.vault = true; fixture.bound = false;
  fixture.listPage.mockRejectedValue(new Error("Private credential or provider failure"));
  const result = await listVaultFilesForOrg(org);
  expect(result).toMatchObject({ status: "unavailable", source: "cloud", files: [] });
  expect(JSON.stringify(result)).not.toContain("Private credential");
});
test.each([0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid limit %s before storage work", async (limit) => {
  await expect(listVaultFilesForOrg(org, { limit })).rejects.toMatchObject({ code: "invalid_page" });
  expect(fixture.listPage).not.toHaveBeenCalled();
});
test.each(["", "local1:-1", "local1:201", "local1:01", "cloud1:", "unknown:0", `cloud1:${"x".repeat(2049)}`])("rejects malformed page token before storage work", async (pageToken) => {
  await expect(listVaultFilesForOrg(org, { pageToken })).rejects.toMatchObject({ code: "invalid_page" });
  expect(fixture.listPage).not.toHaveBeenCalled();
});
test("a backend change rejects its previous cursor and leaves a fresh first page available", async () => {
  fixture.bound = false;
  await expect(listVaultFilesForOrg(org, { pageToken: "local1:50" })).rejects.toMatchObject({ code: "invalid_page" });
  expect(fixture.listPage).not.toHaveBeenCalled();
  expect(await listVaultFilesForOrg(org)).toMatchObject({ source: "cloud", status: "ready" });
});
test("signed-out and foreign membership checks fail before reading vault configuration", async () => {
  fixture.user = false;
  await expect(listVaultFilesForOrg(org)).rejects.toMatchObject({ code: "unauthorized" });
  expect(fixture.queries).not.toHaveBeenCalled();
  fixture.user = true; fixture.member = false;
  await expect(listVaultFilesForOrg(org)).rejects.toMatchObject({ name: "OrgMembershipError" });
  expect(fixture.queries).not.toHaveBeenCalled();
  expect(fixture.listPage).not.toHaveBeenCalled();
});

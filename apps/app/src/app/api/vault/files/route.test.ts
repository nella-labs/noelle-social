import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { OrgMembershipError } from "@noelle/runtime";

const fixture = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/auth-cookie", () => ({ getUserFromCookies: async () => ({ id: "fixture-user" }) }));
vi.mock("@/lib/db", () => ({ pgOrgMembersClient: () => async () => [{ user_id: "fixture-user" }], sql: async () => [{ storage_bucket: "fixture-bucket", storage_prefix: "fixture/" }] }));
vi.mock("@noelle/runtime/vault-storage", async (original) => ({ ...await original<typeof import("@noelle/runtime/vault-storage")>(), createGcsStorage: async () => ({}), createVaultStorage: () => ({ list: async () => [] }) }));
vi.mock("@/lib/vault", async (original) => ({ ...await original<typeof import("@/lib/vault")>(), listVaultFilesForOrg: fixture.list }));
import { VaultListingError } from "@/lib/vault";
import { GET } from "./route";
const orgId = "11111111-1111-4111-8111-111111111111";
const request = (query = `orgId=${orgId}`) => new Request(`http://localhost/api/vault/files?${query}`);
beforeEach(() => {
  fixture.list.mockReset();
  fixture.list.mockResolvedValue({ status: "ready", source: "local", files: [{ path: "fixture/local.md", size: 12, updatedISO: "2026-10-05T00:00:00Z" }], partial: true, nextPageToken: "local1:50" });
  vi.spyOn(http, "request").mockImplementation(() => { throw new Error("HTTP forbidden in listing tests"); });
  vi.spyOn(https, "request").mockImplementation(() => { throw new Error("HTTPS forbidden in listing tests"); });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Fetch forbidden in listing tests"); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
test("serves the authoritative local page with partial and continuation fields", async () => {
  const result = await GET(request());
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ source: "local", partial: true, nextPageToken: "local1:50" });
  expect(fixture.list).toHaveBeenCalledWith(orgId, {});
});
test("passes cloud continuation intact through query decoding", async () => {
  const token = "cloud1:provider+/next=";
  await GET(request(new URLSearchParams({ orgId, pageToken: token, limit: "2" }).toString()));
  expect(fixture.list).toHaveBeenCalledWith(orgId, { pageToken: token, limit: 2 });
});
test.each(["orgId=bad", `orgId=${orgId}&limit=no`, `orgId=${orgId}&limit=1.5`, `orgId=${orgId}&limit=`])("rejects malformed query without a listing call", async (query) => {
  expect((await GET(request(query))).status).toBe(400);
  expect(fixture.list).not.toHaveBeenCalled();
});
test.each(["unauthorized", "invalid_page"] as const)("maps typed %s without exposing internal messages", async (code) => {
  fixture.list.mockRejectedValue(new VaultListingError(code));
  const response = await GET(request());
  expect(response.status).toBe(code === "unauthorized" ? 401 : 400);
  expect(await response.json()).toMatchObject({ error: code });
});
test("foreign membership remains forbidden", async () => {
  fixture.list.mockRejectedValue(new OrgMembershipError("fixture-user", orgId));
  expect((await GET(request())).status).toBe(403);
});
test("unavailable storage is503 and unprovisioned is distinguishable200", async () => {
  fixture.list.mockResolvedValue({ status: "unavailable", source: "cloud", files: [], partial: false, nextPageToken: null, message: "Could not load this vault listing. Try again." });
  expect((await GET(request())).status).toBe(503);
  fixture.list.mockResolvedValue({ status: "unprovisioned", source: null, files: [], partial: false, nextPageToken: null });
  const response = await GET(request());
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: "unprovisioned" });
});

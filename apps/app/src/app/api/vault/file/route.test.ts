import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StorageDeps, VaultStorage } from "@noelle/runtime/vault-storage";

const { getUserFromCookies, assertOrgMember, sqlMock, readText, localRoot, localSource, denyIO } = vi.hoisted(() => ({
  getUserFromCookies: vi.fn(),
  assertOrgMember: vi.fn(),
  sqlMock: vi.fn(),
  readText: vi.fn(),
  localRoot: vi.fn(),
  localSource: vi.fn(),
  denyIO: vi.fn(() => { throw new Error("Network denied in preview fixture"); }),
}));

vi.mock("@/lib/auth-cookie", () => ({ getUserFromCookies }));
vi.mock("@/lib/db", () => ({
  sql: Object.assign(sqlMock, { unsafe: vi.fn(async () => []) }),
  pgOrgMembersClient: () => ({}),
}));
vi.mock("@noelle/runtime", () => ({
  assertOrgMember,
  OrgMembershipError: class OrgMembershipError extends Error {},
}));
vi.mock("@/lib/vault", () => ({ resolveLocalVaultRootForOrg: localRoot }));
vi.mock("@/lib/vault-fs", () => ({ readVaultSource: localSource, VAULT_PREVIEW_MAX_BYTES: 4 * 1024 * 1024 }));
vi.mock("node:http", async original => ({ ...await original<object>(), request: denyIO, get: denyIO }));
vi.mock("node:https", async original => ({ ...await original<object>(), request: denyIO, get: denyIO }));
vi.mock("@noelle/runtime/vault-storage", async original => ({
  ...await original<object>(),
  createGcsStorage: async () => ({}),
  createVaultStorage: () => ({ readText }),
}));

import { GET } from "./route";

const ORG = "11111111-1111-1111-1111-111111111111";

function req(params: Record<string, string>): Request {
  const u = new URL("http://localhost/api/vault/file");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new Request(u);
}

beforeEach(() => {
  getUserFromCookies.mockReset();
  assertOrgMember.mockReset();
  sqlMock.mockReset();
  readText.mockReset();
  localRoot.mockReset().mockResolvedValue(null); localSource.mockReset(); denyIO.mockClear();
  vi.stubGlobal("fetch", denyIO);
});
afterEach(() => { expect(denyIO).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

function authorize() {
  getUserFromCookies.mockResolvedValue({ id: "u1" }); assertOrgMember.mockResolvedValue(undefined);
  sqlMock.mockResolvedValue([{ storage_bucket: "fixture", storage_prefix: "tenant/" }]);
}
async function actualCloudRead(download: () => Promise<Buffer>) {
  const { createVaultStorage } = await vi.importActual<typeof import("@noelle/runtime/vault-storage")>("@noelle/runtime/vault-storage");
  const storage = createVaultStorage({ bucket: () => ({ file: () => ({ download: async () => [await download()] }) }) } as unknown as StorageDeps);
  readText.mockImplementation((args: Parameters<VaultStorage["readText"]>[0]) => storage.readText(args));
}

describe("GET /api/vault/file", () => {
  it("returns413 for the actual canonical cloud preview byte cap", async () => {
    authorize(); await actualCloudRead(async () => Buffer.alloc(4 * 1024 * 1024 + 1));
    const response = await GET(req({ orgId: ORG, path: "a.md" }));
    expect(response.status).toBe(413); expect((await response.json()).error).toBe("too_large");
  });
  it("returns422 for actual canonical malformed cloud text without replacement characters", async () => {
    authorize(); await actualCloudRead(async () => Buffer.from([255]));
    const response = await GET(req({ orgId: ORG, path: "a.md" }));
    expect(response.status).toBe(422); expect((await response.json()).error).toBe("invalid_encoding");
  });
  it.each([404, 503])("maps an actual cloud HTTP%s failure to scoped safe JSON", async status => {
    authorize();
    const { createGcsObjectClient } = await vi.importActual<typeof import("@noelle/runtime/gcs-objects")>("@noelle/runtime/gcs-objects");
    const fetchImpl = vi.fn(async () => new Response("private provider diagnostics", { status }));
    const objects = createGcsObjectClient({ getAccessToken: async () => "fixture", fetchImpl });
    await actualCloudRead(() => objects.read({ bucket: "fixture", name: "tenant/a.md", maxBytes: 4 * 1024 * 1024 }));
    const response = await GET(req({ orgId: ORG, path: "a.md" }));
    expect(response.status).toBe(status); expect(await response.text()).not.toContain("private provider diagnostics");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("reports invalid local text with the same safe encoding status", async () => {
    authorize(); localRoot.mockResolvedValue("/fixture"); localSource.mockResolvedValue({ kind: "invalid_encoding" });
    const response = await GET(req({ orgId: ORG, path: "a.md" }));
    expect(response.status).toBe(422); expect(readText).not.toHaveBeenCalled();
  });
  it.each([["unavailable", 503], ["changed", 409]] as const)("does not label a %s local source as missing", async (kind, status) => {
    authorize(); localRoot.mockResolvedValue("/fixture"); localSource.mockResolvedValue({ kind });
    const response = await GET(req({ orgId: ORG, path: "a.md" }));
    expect(response.status).toBe(status); expect((await response.json()).error).toBe(kind);
    expect(readText).not.toHaveBeenCalled();
  });
  it("401 when not signed in", async () => {
    getUserFromCookies.mockResolvedValue(null);
    const res = await GET(req({ orgId: ORG, path: "a.md" }));
    expect(res.status).toBe(401);
  });

  it("400 on bad orgId", async () => {
    getUserFromCookies.mockResolvedValue({ id: "u1" });
    const res = await GET(req({ orgId: "nope", path: "a.md" }));
    expect(res.status).toBe(400);
  });

  it("400 on path traversal", async () => {
    getUserFromCookies.mockResolvedValue({ id: "u1" });
    assertOrgMember.mockResolvedValue(undefined);
    const res = await GET(req({ orgId: ORG, path: "../escape.md" }));
    expect(res.status).toBe(400);
  });

  it("400 on percent-encoded traversal + null byte (URL decodes before validation)", async () => {
    getUserFromCookies.mockResolvedValue({ id: "u1" });
    assertOrgMember.mockResolvedValue(undefined);
    // Raw query strings so the encoding reaches the handler: %2E%2E%2F → "../",
    // %00 → NUL. searchParams.get() decodes once, then the Zod refine rejects.
    for (const raw of [`orgId=${ORG}&path=%2E%2E%2Fescape.md`, `orgId=${ORG}&path=a%00.md`]) {
      const res = await GET(new Request(`http://localhost/api/vault/file?${raw}`));
      expect(res.status).toBe(400);
    }
  });

  it("403 for non-members", async () => {
    getUserFromCookies.mockResolvedValue({ id: "u1" });
    const { OrgMembershipError } = await import("@noelle/runtime");
    assertOrgMember.mockRejectedValue(new OrgMembershipError("u1", ORG));
    const res = await GET(req({ orgId: ORG, path: "a.md" }));
    expect(res.status).toBe(403);
  });

  it("200 returns the file body", async () => {
    getUserFromCookies.mockResolvedValue({ id: "u1" });
    assertOrgMember.mockResolvedValue(undefined);
    sqlMock.mockResolvedValue([{ storage_bucket: "noelle-vaults", storage_prefix: "operator/" }]);
    readText.mockResolvedValue("# Company\n");
    const res = await GET(req({ orgId: ORG, path: "01-business/company.md" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "01-business/company.md", body: "# Company\n" });
    expect(readText).toHaveBeenCalledWith({
      bucket: "noelle-vaults",
      prefix: "operator/",
      filename: "01-business/company.md",
    });
  });
});

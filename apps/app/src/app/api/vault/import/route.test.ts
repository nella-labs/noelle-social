import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the route's request validation, the slug↔id binding, and that
// each file is forwarded to vaultStorage.writeText. The downstream GCS
// + provision helpers are mocked so the test stays at the orchestration
// layer.

const { writeText, provisionVaultForOrg, sqlMock, getOrgBySlug } = vi.hoisted(
  () => ({
    writeText: vi.fn(async () => undefined),
    provisionVaultForOrg: vi.fn(async () => ({
      id: "v1",
      org_id: "org-1",
      nella_workspace_id: "mars-acme",
      storage_bucket: "noelle-vaults",
      storage_prefix: "acme/",
      status: "provisioning",
    })),
    sqlMock: vi.fn(async () => []),
    // `id` MUST equal the orgId the happy-path request body sends, or the
    // route's slug↔id guard rejects it with `org_mismatch` (400). The
    // slug↔id-mismatch test overrides this return per-call.
    getOrgBySlug: vi.fn(async () => ({
      id: "00000000-0000-0000-0000-000000000001",
      slug: "acme",
      name: "Acme",
    })),
  }),
);

vi.mock("@noelle/runtime", async () => ({
  assertOrgMember: vi.fn(async () => undefined),
  OrgMembershipError: class OrgMembershipError extends Error {},
  provisionVaultForOrg,
}));
vi.mock("@noelle/runtime/vault-storage", async () => ({
  createVaultStorage: () => ({
    writeText,
    signUpload: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  }),
  createGcsStorage: async () => ({}),
}));
vi.mock("@/lib/auth-cookie", () => ({
  getUserFromCookies: vi.fn(async () => ({ id: "user-1", email: "ada@example.com" })),
}));
vi.mock("@/lib/db", () => ({
  sql: Object.assign(sqlMock, { unsafe: vi.fn(async () => []) }),
  pgOrgMembersClient: () => ({}),
}));
vi.mock("@/lib/queries", () => ({ getOrgBySlug }));

import { POST } from "./route";

function jsonReq(body: unknown): Request {
  return new Request("https://app.test/api/vault/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  writeText.mockClear();
  provisionVaultForOrg.mockClear();
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
  getOrgBySlug.mockClear();
});

describe("POST /api/vault/import", () => {
  it("rejects path traversal in the file list", async () => {
    const res = await POST(
      jsonReq({
        orgId: "00000000-0000-0000-0000-000000000001",
        orgSlug: "acme",
        files: [{ path: "../etc/passwd.md", body: "# nope" }],
      }),
    );
    expect(res.status).toBe(400);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("rejects files that are not .md", async () => {
    const res = await POST(
      jsonReq({
        orgId: "00000000-0000-0000-0000-000000000001",
        orgSlug: "acme",
        files: [{ path: "notes.txt", body: "hi" }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects slug↔id mismatch", async () => {
    getOrgBySlug.mockResolvedValueOnce({ id: "different-org", slug: "acme", name: "x" });
    const res = await POST(
      jsonReq({
        orgId: "00000000-0000-0000-0000-000000000001",
        orgSlug: "acme",
        files: [{ path: "ok.md", body: "# ok" }],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("org_mismatch");
  });

  it("writes each file and marks stage when requested", async () => {
    const res = await POST(
      jsonReq({
        orgId: "00000000-0000-0000-0000-000000000001",
        orgSlug: "acme",
        files: [
          { path: "posts/one.md", body: "# one" },
          { path: "posts/two.md", body: "# two" },
        ],
        markStage: "light",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(writeText).toHaveBeenCalledTimes(2);
    // The stage update is the final sql call.
    expect(sqlMock).toHaveBeenCalled();
  });

  it("rejects oversized total payload", async () => {
    // Each file just under the 512KiB per-file cap; ~16 files crosses 8MiB.
    const big = "x".repeat(510 * 1024);
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `posts/${i}.md`,
      body: big,
    }));
    const res = await POST(
      jsonReq({
        orgId: "00000000-0000-0000-0000-000000000001",
        orgSlug: "acme",
        files,
      }),
    );
    expect(res.status).toBe(413);
  });
});

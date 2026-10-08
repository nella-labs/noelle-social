import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the Secret Manager wrapper before importing the module under test.
//
// The fake client is keyed off the exact resource name passed to getSecret /
// listSecretVersions / accessSecretVersion. Each test seeds the maps below
// before calling getConnectionStatus().
// ---------------------------------------------------------------------------

interface FakeVersion {
  name: string;
  createTimeSeconds: number;
  payload: string;
}

const secretsByName = new Map<string, FakeVersion[]>();

const fakeClient = {
  async getSecret({ name }: { name: string }) {
    if (!secretsByName.has(name)) {
      const err = new Error(`NOT_FOUND ${name}`) as Error & { code: number };
      err.code = 5;
      throw err;
    }
    return [{ name }];
  },
  async listSecretVersions({ parent }: { parent: string; filter?: string }) {
    const versions = secretsByName.get(parent) ?? [];
    // Mirror real API: newest-first.
    const newestFirst = [...versions].sort(
      (a, b) => b.createTimeSeconds - a.createTimeSeconds,
    );
    return [
      newestFirst.map((v) => ({
        name: v.name,
        createTime: { seconds: v.createTimeSeconds, nanos: 0 },
      })),
    ];
  },
  async accessSecretVersion({ name }: { name: string }) {
    // Look up by version name across all secrets.
    for (const versions of secretsByName.values()) {
      const hit = versions.find((v) => v.name === name);
      if (hit) {
        return [{ payload: { data: Buffer.from(hit.payload) } }];
      }
    }
    const err = new Error(`NOT_FOUND ${name}`) as Error & { code: number };
    err.code = 5;
    throw err;
  },
};

vi.mock("./sm", () => ({
  SM_PROJECT: "noelle-agents",
  getSecretManagerClient: async () => fakeClient,
}));

// Import AFTER vi.mock has been registered. Vitest hoists vi.mock to the top
// of the module, so this is safe.
const { getConnectionStatus } = await import("./connections");

function seedPerOrg(
  orgId: string,
  fragment: string,
  payload: string,
  createTimeSeconds = 1_700_000_000,
) {
  const secretName = `projects/noelle-agents/secrets/noelle--org--${orgId}--${fragment}`;
  const versions = secretsByName.get(secretName) ?? [];
  versions.push({
    name: `${secretName}/versions/${versions.length + 1}`,
    createTimeSeconds,
    payload,
  });
  secretsByName.set(secretName, versions);
}

function seedGlobal(
  fragment: string,
  payload: string,
  createTimeSeconds = 1_700_000_000,
) {
  const secretName = `projects/noelle-agents/secrets/noelle-worker-${fragment}`;
  const versions = secretsByName.get(secretName) ?? [];
  versions.push({
    name: `${secretName}/versions/${versions.length + 1}`,
    createTimeSeconds,
    payload,
  });
  secretsByName.set(secretName, versions);
}

beforeEach(() => {
  secretsByName.clear();
});

describe("getConnectionStatus", () => {
  it("reports not_set + source:null when neither per-org nor global exists", async () => {
    const status = await getConnectionStatus("org-abc", "gemini");
    expect(status.status).toBe("not_set");
    expect(status.source).toBeNull();
    expect(status.preview).toBeNull();
    expect(status.lastUpdatedAt).toBeNull();
  });

  it("reports connected + source:'global' when only the legacy default exists", async () => {
    // Bring-up seeded a global key; user hasn't pasted a per-org value yet.
    seedGlobal("gemini-api-key", "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXX");
    const status = await getConnectionStatus("org-abc", "gemini");
    expect(status.status).toBe("connected");
    expect(status.source).toBe("global");
    // Preview should mask the value (first4…last4 since length >= 12).
    expect(status.preview).toMatch(/^AIza…/);
    expect(status.lastUpdatedAt).not.toBeNull();
  });

  it("reports connected + source:'org' when only the per-org secret exists", async () => {
    seedPerOrg("org-abc", "gemini-api-key", "AIzaSyPerOrgValueXXXXXXXXXX");
    const status = await getConnectionStatus("org-abc", "gemini");
    expect(status.status).toBe("connected");
    expect(status.source).toBe("org");
  });

  it("per-org takes precedence over global when both exist", async () => {
    // Global default still in place from bring-up, AND user pasted a
    // workspace-specific override. The card must reflect the org value.
    seedGlobal("gemini-api-key", "AIzaSyGlobalXXXXXXXXXXXXXXXX");
    seedPerOrg("org-abc", "gemini-api-key", "AIzaSyWorkspaceXXXXXXXXXXXX");
    const status = await getConnectionStatus("org-abc", "gemini");
    expect(status.status).toBe("connected");
    expect(status.source).toBe("org");
    // Preview must come from the per-org value, not the global one.
    expect(status.preview).toContain("AIza");
    expect(status.preview).not.toMatch(/global/);
  });

  it("isolates per-org values across workspaces (org-a does not see org-b)", async () => {
    seedPerOrg("org-a", "gemini-api-key", "AIzaSyOrgAValueXXXXXXXXXXX");
    // org-b has no per-org value and no global fallback → not_set.
    const aStatus = await getConnectionStatus("org-a", "gemini");
    const bStatus = await getConnectionStatus("org-b", "gemini");
    expect(aStatus.source).toBe("org");
    expect(bStatus.status).toBe("not_set");
    expect(bStatus.source).toBeNull();
  });
});

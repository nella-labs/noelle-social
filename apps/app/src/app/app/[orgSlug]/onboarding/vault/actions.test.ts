import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TransactionSql } from "postgres";

// We mock the modules the action depends on so the test stays at the
// orchestration layer — no real DB or GCS.

// vi.hoisted ensures variables are available when vi.mock factories run
// (vi.mock is hoisted to the top of the file by vitest's transform).
const { writeText, provisionVaultForOrg, renderVaultTemplate, sqlMock } = vi.hoisted(() => {
  const writeText = vi.fn(async () => undefined);
  const provisionVaultForOrg = vi.fn(async () => ({
    id: "22222222-2222-4222-8222-222222222222",
    org_id: "11111111-1111-4111-8111-111111111111",
    nella_workspace_id: "mars-acme",
    storage_bucket: "noelle-vaults",
    storage_prefix: "acme/",
    status: "provisioning",
  }));
  const renderVaultTemplate = vi.fn(() => [
    { path: "00-vault-map.md", body: "# Vault map\n" },
  ]);
  const sqlMock = vi.fn();
  // The action serializes the answers payload via sql.json(...); postgres.js
  // exposes that as a method on the tagged-template fn. Stub it (identity is
  // enough — the test asserts on renderVaultTemplate's args, not the SQL params).
  (sqlMock as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return { writeText, provisionVaultForOrg, renderVaultTemplate, sqlMock };
});

vi.mock("@noelle/runtime", async () => ({
  assertOrgMember: vi.fn(async () => undefined),
  provisionVaultForOrg,
}));
vi.mock("@noelle/runtime/vault-storage", async () => ({
  createVaultStorage: () => ({ writeText, signUpload: vi.fn(), list: vi.fn(), delete: vi.fn() }),
  createGcsStorage: async () => ({}),
}));
vi.mock("@noelle/runtime/vault-template", async () => ({
  renderVaultTemplate,
}));
vi.mock("@/lib/auth-cookie", () => ({
  getUserFromCookies: vi.fn(async () => ({ id: "user-1", email: "ada@example.com" })),
}));

vi.mock("@/lib/queries", () => ({ getOrgBySlug: async (slug: string) => slug === "acme"
  ? { id: "11111111-1111-4111-8111-111111111111", slug: "acme" } : null }));

vi.mock("@/lib/db", () => ({
  sql: sqlMock,
  withTx: (operation: (tx: TransactionSql) => Promise<unknown>) => operation(sqlMock as unknown as TransactionSql),
  pgOrgMembersClient: () => ({}),
}));

// Import after mocks.
import { submitVaultStage } from "./actions";

beforeEach(() => {
  writeText.mockClear();
  provisionVaultForOrg.mockClear();
  renderVaultTemplate.mockClear();
  sqlMock.mockReset();
});

describe("submitVaultStage", () => {
  it("light: provisions vault, renders + writes files, upserts answers, sets stage", async () => {
    // sql calls in order: load existing answers, upsert answers, update vaults.wizard_stage
    sqlMock
      .mockResolvedValueOnce([]) // load existing → none
      .mockResolvedValueOnce([]) // upsert answers
      .mockResolvedValueOnce([{ id: "22222222-2222-4222-8222-222222222222" }]); // update wizard_stage

    const res = await submitVaultStage({
      orgId: "11111111-1111-4111-8111-111111111111",
      orgSlug: "acme",
      stage: "light",
      answers: {
        personName: "Ada",
        oneLineWhat: "we ship agents",
        audience: "builders",
      },
    });

    expect(res).toEqual({ ok: true, nextStep: "medium" });
    expect(provisionVaultForOrg).toHaveBeenCalledOnce();
    expect(renderVaultTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "light", slug: "acme" }),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "noelle-vaults",
        prefix: "acme/",
        filename: "00-vault-map.md",
        body: "# Vault map\n",
      }),
    );
  });

  it("rejects malformed light answers", async () => {
    const res = await submitVaultStage({
      orgId: "11111111-1111-4111-8111-111111111111",
      orgSlug: "acme",
      stage: "light",
      answers: { personName: "" },
    });
    expect(res.ok).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("medium: merges prior light answers", async () => {
    sqlMock
      .mockResolvedValueOnce([
        {
          org_id: "11111111-1111-4111-8111-111111111111",
          stage_completed: "light",
          answers: { personName: "Ada", oneLineWhat: "x", audience: "y" },
          updated_at: "2026-05-26T00:00:00Z",
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "22222222-2222-4222-8222-222222222222" }]);

    await submitVaultStage({
      orgId: "11111111-1111-4111-8111-111111111111",
      orgSlug: "acme",
      stage: "medium",
      answers: {
        voiceDos: ["a", "b", "c"],
        voiceDonts: ["a", "b", "c"],
        bannedPhrases: [],
        contentPillars: ["a", "b", "c"],
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const called = (renderVaultTemplate.mock.calls as any)[0]?.[0] as
      | { stage: string; answers: Record<string, unknown>; slug: string }
      | undefined;
    expect(called?.answers).toMatchObject({
      personName: "Ada",
      voiceDos: ["a", "b", "c"],
    });
  });

  it("rich: returns nextStep done", async () => {
    sqlMock
      .mockResolvedValueOnce([
        {
          org_id: "11111111-1111-4111-8111-111111111111",
          stage_completed: "medium",
          answers: {
            personName: "Ada",
            oneLineWhat: "x",
            audience: "y",
            voiceDos: ["a", "b", "c"],
            voiceDonts: ["a", "b", "c"],
            bannedPhrases: [],
            contentPillars: ["a", "b", "c"],
          },
          updated_at: "2026-05-26T00:00:00Z",
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "22222222-2222-4222-8222-222222222222" }]);

    const res = await submitVaultStage({
      orgId: "11111111-1111-4111-8111-111111111111",
      orgSlug: "acme",
      stage: "rich",
      answers: {
        cadenceExamples: ["a", "b", "c"],
        samplePosts: ["a", "b", "c"],
      },
    });
    expect(res).toEqual({ ok: true, nextStep: "done" });
  });
});

const orgId = "11111111-1111-4111-8111-111111111111";
const light = { personName: "Synthetic voice", oneLineWhat: "Synthetic product", audience: "Synthetic audience" };
it("rejects a mismatched slug before prior/provision/storage work", async () => {
  expect(await submitVaultStage({ orgId, orgSlug: "missing", stage: "light", answers: light })).toEqual({ ok: false, error: "not_found" });
  expect(sqlMock).not.toHaveBeenCalled(); expect(provisionVaultForOrg).not.toHaveBeenCalled(); expect(writeText).not.toHaveBeenCalled();
});
it.each(["not-a-uuid", ""])("rejects invalid org id %j before writes", async orgId => {
  expect(await submitVaultStage({ orgId, orgSlug: "acme", stage: "light", answers: light })).toEqual({ ok: false, error: "invalid_input" });
  expect(sqlMock).not.toHaveBeenCalled(); expect(writeText).not.toHaveBeenCalled();
});
it("does not acknowledge a missing vault stage row", async () => {
  sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  await expect(submitVaultStage({ orgId, orgSlug: "acme", stage: "light", answers: light })).rejects.toThrow("Vault no longer available");
});
it("storage failure cannot start final marker persistence", async () => {
  sqlMock.mockResolvedValueOnce([]); writeText.mockRejectedValueOnce(new Error("inert storage failure"));
  await expect(submitVaultStage({ orgId, orgSlug: "acme", stage: "light", answers: light })).rejects.toThrow("inert storage failure");
  expect(sqlMock).toHaveBeenCalledTimes(1);
});

import { describe, it, expect, vi } from "vitest";
import { provisionVaultForOrg } from "./vaultProvision.js";

describe("provisionVaultForOrg", () => {
  it("inserts a new vault row when none exists", async () => {
    const db = vi.fn(async (sql: string, _params: ReadonlyArray<unknown>) => {
      if (sql.startsWith("select")) return [];
      return [
        {
          id: "v1",
          org_id: "o1",
          nella_workspace_id: "mars-acme",
          storage_bucket: "noelle-vaults",
          storage_prefix: "acme/",
          status: "provisioning",
        },
      ];
    });
    const row = await provisionVaultForOrg({ db, orgId: "o1", orgSlug: "acme" });
    expect(row).toMatchObject({
      nella_workspace_id: "mars-acme",
      storage_bucket: "noelle-vaults",
      storage_prefix: "acme/",
    });
    expect(db).toHaveBeenCalledTimes(2);
    const insertCall = db.mock.calls[1];
    expect(insertCall?.[0]).toContain("insert into noelle.vaults");
    expect(insertCall?.[1]).toEqual(["o1", "mars-acme", "noelle-vaults", "acme/"]);
  });

  it("is idempotent — returns the existing row without inserting", async () => {
    const existing = {
      id: "v1",
      org_id: "o1",
      nella_workspace_id: "mars-acme",
      storage_bucket: "noelle-vaults",
      storage_prefix: "acme/",
      status: "active",
    };
    const db = vi.fn(async (sql: string, _params: ReadonlyArray<unknown>) => {
      if (sql.startsWith("select")) return [existing];
      return [];
    });
    const row = await provisionVaultForOrg({ db, orgId: "o1", orgSlug: "acme" });
    expect(row).toEqual(existing);
    expect(db).toHaveBeenCalledTimes(1);
  });

  it("honors a custom bucket name when provided", async () => {
    const db = vi.fn(async (sql: string, _params: ReadonlyArray<unknown>) => {
      if (sql.startsWith("select")) return [];
      return [
        {
          id: "v1",
          org_id: "o1",
          nella_workspace_id: "mars-acme",
          storage_bucket: "noelle-vaults-staging",
          storage_prefix: "acme/",
          status: "provisioning",
        },
      ];
    });
    await provisionVaultForOrg({
      db,
      orgId: "o1",
      orgSlug: "acme",
      bucket: "noelle-vaults-staging",
    });
    const insertCall = db.mock.calls[1];
    expect(insertCall?.[1]?.[2]).toBe("noelle-vaults-staging");
  });

  it("throws when the insert returns no row", async () => {
    const db = vi.fn(async (sql: string, _params: ReadonlyArray<unknown>) => {
      if (sql.startsWith("select")) return [];
      return [];
    });
    await expect(
      provisionVaultForOrg({ db, orgId: "o1", orgSlug: "acme" }),
    ).rejects.toThrow(/no row/);
  });
});

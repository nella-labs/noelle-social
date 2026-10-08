import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listMigrations, SKIP_MIGRATIONS } from "./migrate.js";
import { findRepoRoot } from "../config.js";

const schemaDir = resolve(findRepoRoot(), "infra/cloudsql/schema");

describe("listMigrations", () => {
  it("starts with the base schema then seed", () => {
    const files = listMigrations(schemaDir);
    expect(files[0]).toBe("0001_noelle_schema.sql");
    expect(files[1]).toBe("0002_seed_pablo.sql");
  });

  it("applies 0004 (adds drafts.sent_at) BEFORE 0003_x_watchlist (indexes it)", () => {
    const files = listMigrations(schemaDir);
    const i4 = files.indexOf("0004_drafts_sent_at.sql");
    const i3 = files.indexOf("0003_x_watchlist.sql");
    expect(i4).toBeGreaterThanOrEqual(0);
    expect(i3).toBeGreaterThanOrEqual(0);
    expect(i4).toBeLessThan(i3);
  });

  it("skips the Vercel WIF grant migration (nonexistent role locally)", () => {
    const files = listMigrations(schemaDir);
    expect(files).not.toContain("0003_grant_vercel_wif_user.sql");
    expect(SKIP_MIGRATIONS.has("0003_grant_vercel_wif_user.sql")).toBe(true);
  });

  it("still includes the tables that grant to the IAM role (0005, 0016)", () => {
    const files = listMigrations(schemaDir);
    expect(files).toContain("0005_invited_emails.sql");
    expect(files).toContain("0016_alpha_invitations.sql");
  });

  it("only returns .sql files", () => {
    expect(listMigrations(schemaDir).every((f) => f.endsWith(".sql"))).toBe(true);
  });
});

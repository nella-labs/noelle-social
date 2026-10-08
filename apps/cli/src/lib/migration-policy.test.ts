import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "../config.js";
import { listMigrations } from "./migrate.js";
import { CONCURRENT_INDEX_MIGRATIONS, transactionalMigrationBody } from "./migration-policy.js";

describe("explicit local migration policy", () => {
  it("classifies every current migration and removes only the four historical wrappers", () => {
    const schema = resolve(findRepoRoot(), "infra/cloudsql/schema");
    let wrappers = 0;
    for (const file of listMigrations(schema)) {
      const body = readFileSync(resolve(schema, file), "utf8");
      if (CONCURRENT_INDEX_MIGRATIONS[file]) continue;
      const prepared = transactionalMigrationBody(file, body);
      if (prepared !== body) wrappers++;
      expect(prepared).not.toMatch(/^\s*(begin|commit);\s*$/im);
    }
    expect(wrappers).toBe(4);
  });
  it("requires explicit ownership before accepting a new transaction-control file", () => {
    expect(() => transactionalMigrationBody("future.sql", "begin;\nselect 1;\ncommit;")).toThrow("requires migration policy");
    expect(() => transactionalMigrationBody("0011_rename_drafter_codex_bucket.sql", "begin;\nselect 1;")).toThrow("Invalid historical");
  });
});

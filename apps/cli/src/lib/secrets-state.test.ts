import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateSecrets } from "./secrets-state.js";
import type { Paths } from "../config.js";

describe("durable local credentials", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "noelle-secrets-test-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const paths = () => ({ home }) as Paths;
  const file = () => join(home, "secrets.json");

  it.each(["{partial", "null", "[]", "42", '{"jwtSecret":42}', '{"jwtSecret":""}'])(
    "refuses invalid existing state without rotating or overwriting it: %s", (body) => {
      writeFileSync(file(), body, { mode: 0o600 });
      expect(() => loadOrCreateSecrets(paths())).toThrow("Invalid local secrets state");
      expect(readFileSync(file(), "utf8")).toBe(body);
    },
  );

  it("creates missing state once and preserves every credential on repeated startup", () => {
    const first = loadOrCreateSecrets(paths());
    expect(loadOrCreateSecrets(paths())).toEqual(first);
    expect(Object.values(first)).toHaveLength(6);
    expect(Object.values(first).every((value) => typeof value === "string" && value.length >= 24)).toBe(true);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("fills missing new fields while preserving valid persisted credentials", () => {
    writeFileSync(file(), JSON.stringify({ jwtSecret: "existing-jwt-secret", appPassword: "existing-db-password" }));
    const state = loadOrCreateSecrets(paths());
    expect(state.jwtSecret).toBe("existing-jwt-secret");
    expect(state.appPassword).toBe("existing-db-password");
    expect(state.cronSecret.length).toBeGreaterThanOrEqual(24);
  });
});

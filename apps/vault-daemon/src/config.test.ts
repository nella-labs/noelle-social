import { expect, test } from "vitest";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./config.js";

test("requires an explicit local source and remote workspace prefix", () => {
  expect(() => loadConfig({})).toThrow("VAULT_DIR is required");
  expect(() => loadConfig({ VAULT_DIR: "./voice-vault" })).toThrow("NOELLE_VAULT_PREFIX is required");
  for (const prefix of ["", " ", "/", "///"]) {
    expect(() => loadConfig({ VAULT_DIR: "./voice-vault", NOELLE_VAULT_PREFIX: prefix })).toThrow("NOELLE_VAULT_PREFIX is required");
  }
});

test("preserves configured sync settings and normalizes the workspace prefix", () => {
  expect(loadConfig({ VAULT_DIR: "~/voice-vault", NOELLE_VAULT_PREFIX: " team ", NOELLE_VAULT_BUCKET: "team-vault", VAULT_SYNC_DEBOUNCE_MS: "500", VAULT_SYNC_DELETE_GUARD_PCT: "10" })).toEqual({
    vaultDir: resolve(homedir(), "voice-vault"), bucket: "team-vault", prefix: "team/", debounceMs: 500, deleteGuardPct: 10,
  });
  expect(loadConfig({ VAULT_DIR: "./voice-vault", NOELLE_VAULT_PREFIX: "team/" }).prefix).toBe("team/");
});

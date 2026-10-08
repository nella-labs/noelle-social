import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../config.js";

vi.mock("./platform.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./platform.js")>(),
  platform: () => "darwin",
  run: async (command: string) => {
    if (command !== "which") throw new Error(`Unexpected command: ${command}`);
    return { code: 1, stdout: "", stderr: "" };
  },
}));
vi.mock("./autoupdate.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./autoupdate.js")>(),
  install: async () => {},
  installPostCommitHook: () => {},
}));
vi.mock("./lima.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lima.js")>(),
  limaInstalled: async () => true,
  readVmConfig: async () => JSON.parse(readFileSync(join(process.env.NOELLE_HOME!, "vm.json"), "utf8")),
  writeVmConfig: async (_vm: string, config: unknown) => {
    writeFileSync(join(process.env.NOELLE_HOME!, "vm.json"), JSON.stringify(config));
  },
}));

describe.each(["native", "vm"] as const)("%s autoupdate install branch", (runtime) => {
  let home: string;
  let argv: string[];
  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "noelle-autoupdate-command-"));
    vi.stubEnv("NOELLE_HOME", home);
    argv = process.argv;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it.each([
    { flags: ["--branch", "codex/public-release"], expected: "codex/public-release" },
    { flags: [], expected: "release/stable" },
  ])("persists $expected without resetting other update state", async ({ flags, expected }) => {
    const config = defaultConfig();
    config.runtime = runtime;
    config.autoUpdate.branch = "release/stable";
    config.autoUpdate.intervalMinutes = 23;
    config.autoUpdate.lastBuiltSha = "previous-build";
    config.autoUpdate.lastSyncedSha = "previous-sync";
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    if (runtime === "vm") writeFileSync(join(home, "vm.json"), JSON.stringify(config));
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    process.argv = [process.execPath, "noelle", "autoupdate", "install", "--repo", home, ...flags];

    await import("../index.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    const saved = JSON.parse(readFileSync(join(home, runtime === "native" ? "config.json" : "vm.json"), "utf8"));
    expect(saved.autoUpdate).toEqual({ ...config.autoUpdate, enabled: true, branch: expected });
    expect(saved.operator).toEqual(config.operator);
    expect(saved.runtime).toBe(runtime);
  });
});

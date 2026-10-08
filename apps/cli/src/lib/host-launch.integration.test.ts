import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as autostart from "./autostart.js";
import * as autoupdate from "./autoupdate.js";

describe.each([["login", autostart], ["update", autoupdate]] as const)("native host %s generation", (_kind, owner) => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "noelle-host-launch-")); });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

  it("keeps launchd registration under the OS user home when state lives elsewhere", () => {
    vi.stubEnv("NOELLE_HOME", join(directory, "custom-state"));
    expect(owner.plistPath()).toBe(resolve(homedir(), "Library", "LaunchAgents", `${owner.LABEL}.plist`));
    expect(owner.launcherPath()).toBe(join(directory, "custom-state", "host", _kind === "login" ? "autostart.sh" : "autoupdate.sh"));
  });

  it("executes literal paths and arguments instead of expanding shell text", () => {
    const entry = join(directory, 'entry $(printf alias) `printf alias` "quoted" \'single\'.cjs');
    writeFileSync(entry, 'console.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.NOELLE_HOME }));');
    const vm = 'vm $(printf alias) `printf alias` "quoted" \'single\'';
    const inputs = { nodeBin: process.execPath, cliEntry: entry, pathDirs: [join(directory, 'bin $(printf alias)')], vm, home: directory };
    const result = spawnSync("/bin/bash", ["-s"], { input: owner.renderLauncher(inputs), encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.args).toEqual(_kind === "login" ? ["autostart-run", "--vm", vm] : ["sync"]);
    expect(receipt.home).toBe(directory);
  });

  it.skipIf(process.platform !== "darwin")("produces a valid native plist for XML-special paths", () => {
    const file = join(directory, "host.plist");
    writeFileSync(file, owner.renderPlist({ label: owner.LABEL, launcher: '/tmp/team & team <build> "launch".sh', log: "/tmp/log & output.log", intervalSeconds: 600 }));
    const result = spawnSync("/usr/bin/plutil", ["-lint", "--", file], { encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});

describe("native post-commit state identity", () => {
  let directory: string;
  beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), "noelle-host-hook-"))); });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

  it.each(["canonical", "symlink"])("uses installed state home from a %s checkout", async (kind) => {
    const home = join(directory, "operator's custom state");
    const entry = join(directory, "entry 'literal'.cjs"), receipt = join(directory, "receipt.json");
    writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ home: process.env.NOELLE_HOME, args: process.argv.slice(2) }));`);
    expect(spawnSync("git", ["init", "--quiet", directory]).status).toBe(0);
    const checkout = kind === "canonical" ? directory : join(directory, "checkout-alias");
    if (kind === "symlink") symlinkSync(directory, checkout, "dir");
    vi.stubEnv("NOELLE_HOME", home);
    autoupdate.installPostCommitHook(checkout, { nodeBin: process.execPath, cliEntry: entry });
    const result = spawnSync("/bin/bash", [join(checkout, ".git/hooks/post-commit")], {
      cwd: checkout, encoding: "utf8", env: { PATH: process.env.PATH, NOELLE_HOME: "different-state" },
    });
    expect(result.status, result.stderr).toBe(0);
    await vi.waitFor(() => expect(existsSync(receipt)).toBe(true));
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ home, args: ["sync"] });
  });
});

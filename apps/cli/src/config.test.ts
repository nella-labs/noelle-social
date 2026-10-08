import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { defaultConfig, loadConfig, parseConfig } from "./config.js";

describe("runtime discriminator", () => {
  it("defaults new installations to native with no build stamp", () => {
    const c = defaultConfig();
    expect(c.runtime).toBe("native");
    expect(c.autoUpdate.lastBuiltSha).toBeNull();
  });

  it("creates a distinct generic operator identity for each installation", () => {
    const first = defaultConfig();
    const second = defaultConfig();
    expect(first.operator.email).toBe("operator@example.com");
    expect(first.orgSlug).toBe("workspace");
    expect(first.operator.sub).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.operator.sub).not.toBe(first.operator.sub);
    expect(parseConfig(JSON.stringify(first))?.operator).toEqual(first.operator);
  });

  it("parseConfig preserves an explicit native runtime", () => {
    const c = parseConfig(JSON.stringify({ runtime: "native" }));
    expect(c?.runtime).toBe("native");
  });

  it("parseConfig backfills runtime=vm for a pre-runtime config.json", () => {
    const c = parseConfig(JSON.stringify({ orgSlug: "existing-workspace" }));
    expect(c?.runtime).toBe("vm");
  });
});

/**
 * loadConfig() deep-merges the `remoteAccess` block so a config.json written
 * before that field existed (or with only a partial sub-object) fills in
 * defaults instead of ending up with `undefined` nested values.
 */
describe("loadConfig remoteAccess merge", () => {
  let home: string;
  const prev = process.env.NOELLE_HOME;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), "noelle-cfg-"));
    process.env.NOELLE_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.NOELLE_HOME;
    else process.env.NOELLE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  function writeConfig(obj: unknown): void {
    writeFileSync(resolve(home, "config.json"), JSON.stringify(obj));
  }

  it("backfills remoteAccess when the key is absent entirely (legacy config)", () => {
    const legacy = { ...defaultConfig() } as Record<string, unknown>;
    delete legacy.remoteAccess;
    writeConfig(legacy);

    const loaded = loadConfig();
    expect(loaded?.remoteAccess).toEqual({
      tailscale: { enabled: false, mode: "https", port: 443, url: null },
      autostart: { enabled: false, vm: "default", vmUpCommand: "noelle up" },
    });
  });

  it("preserves set fields and fills the rest of the sub-object", () => {
    const cfg = defaultConfig();
    // Only `enabled` persisted under tailscale; mode/port/url come from defaults.
    writeConfig({ ...cfg, remoteAccess: { tailscale: { enabled: true } } });

    const loaded = loadConfig();
    expect(loaded?.remoteAccess.tailscale).toEqual({ enabled: true, mode: "https", port: 443, url: null });
    expect(loaded?.remoteAccess.autostart).toEqual({ enabled: false, vm: "default", vmUpCommand: "noelle up" });
  });

  it("keeps a fully-specified remoteAccess intact", () => {
    const cfg = defaultConfig();
    cfg.remoteAccess = {
      tailscale: { enabled: true, mode: "http", port: 8443, url: "http://macmini:8443" },
      autostart: { enabled: true, vm: "noelle", vmUpCommand: "noelle up" },
    };
    writeConfig(cfg);

    expect(loadConfig()?.remoteAccess).toEqual(cfg.remoteAccess);
  });
});

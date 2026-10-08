import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadVoiceSpec,
  voiceSpecPath,
  voiceSpecBlock,
  resetVoiceSpecCache,
} from "./voiceSpec.js";

const origPath = process.env.NOELLE_VOICE_SPEC_PATH;
const origVault = process.env.NOELLE_VAULT_DIR;

function restoreEnv() {
  if (origPath === undefined) delete process.env.NOELLE_VOICE_SPEC_PATH;
  else process.env.NOELLE_VOICE_SPEC_PATH = origPath;
  if (origVault === undefined) delete process.env.NOELLE_VAULT_DIR;
  else process.env.NOELLE_VAULT_DIR = origVault;
}

describe("voiceSpecPath", () => {
  it("returns null when neither path nor vault is set", () => {
    expect(voiceSpecPath({})).toBeNull();
  });
  it("defaults to <vault>/voice-spec.md", () => {
    expect(voiceSpecPath({ NOELLE_VAULT_DIR: "/v" })).toBe("/v/voice-spec.md");
  });
  it("prefers an explicit NOELLE_VOICE_SPEC_PATH", () => {
    expect(voiceSpecPath({ NOELLE_VOICE_SPEC_PATH: "/x/s.md", NOELLE_VAULT_DIR: "/v" })).toBe("/x/s.md");
  });
});

describe("voiceSpecBlock", () => {
  it("is empty without a spec (keeps prompts byte-identical)", () => {
    expect(voiceSpecBlock(null)).toBe("");
  });
  it("is an authoritative block with a spec", () => {
    const b = voiceSpecBlock("be blunt");
    expect(b).toContain("OPERATOR VOICE SPEC");
    expect(b).toContain("be blunt");
  });
});

describe("loadVoiceSpec", () => {
  let dir: string | null = null;
  beforeEach(() => {
    resetVoiceSpecCache();
    delete process.env.NOELLE_VOICE_SPEC_PATH;
    delete process.env.NOELLE_VAULT_DIR;
  });
  afterEach(() => {
    resetVoiceSpecCache();
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
    restoreEnv();
  });

  it("returns null when nothing is configured", () => {
    expect(loadVoiceSpec()).toBeNull();
  });

  it("reads + trims the spec file when present", () => {
    dir = mkdtempSync(join(tmpdir(), "vspec-"));
    const p = join(dir, "voice-spec.md");
    writeFileSync(p, "  lowercase, blunt, first person.  \n");
    process.env.NOELLE_VOICE_SPEC_PATH = p;
    resetVoiceSpecCache();
    expect(loadVoiceSpec()).toBe("lowercase, blunt, first person.");
  });

  it("returns null for an empty/whitespace file", () => {
    dir = mkdtempSync(join(tmpdir(), "vspec-"));
    const p = join(dir, "voice-spec.md");
    writeFileSync(p, "   \n  ");
    process.env.NOELLE_VOICE_SPEC_PATH = p;
    resetVoiceSpecCache();
    expect(loadVoiceSpec()).toBeNull();
  });
});

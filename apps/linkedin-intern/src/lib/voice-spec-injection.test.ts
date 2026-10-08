import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetVoiceSpecCache } from "@noelle/runtime/voice-spec";
import { buildPostDrafterSystem } from "./post-drafter.js";

// The voice-spec LOADER is tested in packages/runtime/src/voiceSpec.test.ts.
// This file keeps the half that is Lyra-specific: that the spec actually reaches
// the post-drafter's system prompt, and that its absence leaves that prompt
// byte-identical.


// Self-contained env save/restore (the loader test in runtime has its own).
const ENV_KEYS = ["NOELLE_VOICE_SPEC_PATH", "NOELLE_VAULT_DIR"] as const;
let saved: Record<string, string | undefined> = {};
function saveEnv() {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
}

describe("buildPostDrafterSystem voice-spec injection", () => {
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

  it("omits the spec block when none is configured (LinkedIn + X)", () => {
    expect(buildPostDrafterSystem("linkedin", null)).not.toContain("OPERATOR VOICE SPEC");
    expect(buildPostDrafterSystem("x", null)).not.toContain("OPERATOR VOICE SPEC");
  });

  it("injects the vault spec into both the LinkedIn and X systems", () => {
    dir = mkdtempSync(join(tmpdir(), "vspec-"));
    const p = join(dir, "voice-spec.md");
    writeFileSync(p, "SPEC_MARKER: write like a tired founder.");
    process.env.NOELLE_VOICE_SPEC_PATH = p;
    resetVoiceSpecCache();
    expect(buildPostDrafterSystem("linkedin", null)).toContain("SPEC_MARKER");
    expect(buildPostDrafterSystem("x", null)).toContain("SPEC_MARKER");
  });
});

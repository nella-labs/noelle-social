import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The operator's VOICE SPEC — the single source of truth for how their posts
 * should read (voice, hard bans, structure, CTA), kept as a markdown file IN
 * THEIR VAULT rather than inlined in code. Shared via @noelle/runtime: the spec
 * describes the OPERATOR's voice, which is one voice across every platform, so
 * both interns read the same file and editing the vault steers all of them. Both the `voice-post` skill and this
 * dashboard drafter read the same file, so editing the vault steers both.
 *
 * When present, the drafter injects it as AUTHORITATIVE guidance above the
 * inlined rules (which remain a backstop). When absent, the system prompt is
 * byte-identical to before — so this is safe to ship dark and turns on the
 * moment a `voice-spec.md` lands in the vault.
 *
 * Path resolution: `NOELLE_VOICE_SPEC_PATH` if set, else
 * `<NOELLE_VAULT_DIR>/voice-spec.md`. Cached with a TTL so operator edits are
 * picked up without a worker restart.
 */

let cache: { text: string | null; at: number } | null = null;
const TTL_MS = 15 * 60_000;

/** Resolve the spec file path from env, or null when no vault is configured. */
export function voiceSpecPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.NOELLE_VOICE_SPEC_PATH?.trim();
  if (explicit) return explicit;
  const vault = env.NOELLE_VAULT_DIR?.trim();
  return vault ? join(vault, "voice-spec.md") : null;
}

/** Read the vault voice spec (trimmed), or null if unset/missing/empty. Cached. */
export function loadVoiceSpec(now: number = Date.now()): string | null {
  if (cache && now - cache.at < TTL_MS) return cache.text;
  const p = voiceSpecPath();
  let text: string | null = null;
  if (p && existsSync(p)) {
    try {
      const raw = readFileSync(p, "utf8").trim();
      text = raw.length ? raw : null;
    } catch {
      text = null;
    }
  }
  cache = { text, at: now };
  return text;
}

/** Drop the cache (tests + after a deliberate reload). */
export function resetVoiceSpecCache(): void {
  cache = null;
}

/**
 * The authoritative block injected into a drafter system prompt when a spec
 * exists. Empty string when absent, so a `.filter(Boolean).join("\n")` prompt is
 * byte-identical to the pre-spec path.
 */
export function voiceSpecBlock(spec: string | null): string {
  return spec
    ? `\nOPERATOR VOICE SPEC (authoritative — the single source of truth, maintained in the operator's vault). Follow it exactly; the rules below reinforce it, they do not override it:\n${spec}\n`
    : "";
}

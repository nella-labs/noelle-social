import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLocalFsKnowledgeBase, parseIncludeDirs, type KnowledgeBase } from "@noelle/runtime";
import type { Env } from "../env.js";

// Vault grounding for Nova's generators. Mirrors the x/linkedin drafters: a
// local-FS BM25 index over the operator's brand/voice docs (NOELLE_VAULT_DIR,
// scoped by NOELLE_VOICE_DIRS). The clips give Nova the viral FORM; this gives
// it the operator's actual SUBSTANCE + VOICE so ideas/scripts aren't generic.

export type VaultKb = Pick<KnowledgeBase, "search">;

/** Build the vault KB, or null when no vault is configured (grounding is then a no-op). */
export function createVaultKb(env: Env): VaultKb | null {
  if (!env.NOELLE_VAULT_DIR) return null;
  return createLocalFsKnowledgeBase({
    dir: env.NOELLE_VAULT_DIR,
    cacheTtlMs: env.NOELLE_KB_CACHE_TTL_MS,
    includeDirs: parseIncludeDirs(env.NOELLE_VOICE_DIRS),
  });
}

/**
 * Absolute path the personal-brand-state.md artifact is written to AND read from,
 * or null when there's no vault to anchor it in (→ both generation and preference
 * become no-ops, fail-open). Kept next to createVaultKb because both own how the
 * vault env maps to a scanned location.
 *
 * The explicit override (NOELLE_PERSONAL_BRAND_STATE_PATH) wins. Otherwise the
 * artifact lands under the FIRST NOELLE_VOICE_DIRS entry so the KB — which scans
 * ONLY the voice dirs when they're set — can index it; a vault-root file would be
 * invisible to search. It falls back to the vault root only when no voice dirs are
 * configured (then the KB indexes the whole vault, so the root is visible).
 */
export function resolvePersonalBrandStatePath(env: Env): string | null {
  if (env.NOELLE_PERSONAL_BRAND_STATE_PATH) return env.NOELLE_PERSONAL_BRAND_STATE_PATH;
  if (!env.NOELLE_VAULT_DIR) return null;
  const first = parseIncludeDirs(env.NOELLE_VOICE_DIRS)[0];
  return first
    ? join(env.NOELLE_VAULT_DIR, first, "personal-brand-state.md")
    : join(env.NOELLE_VAULT_DIR, "personal-brand-state.md");
}

// renderBrandContext (video-generate.ts) collapses each anchor's whitespace then
// clips it to 400 chars. Whitespace-collapse only ever shrinks length, so packing
// the artifact into <=400-char raw pieces guarantees none is truncated.
const ANCHOR_CAP = 400;

/**
 * Split the personal-brand-state artifact into anchor-sized pieces so the drafter's
 * per-anchor 400-char clip never truncates it (the doc as one anchor would lose
 * everything past its frontmatter). Breaks on `## ` section boundaries first, then
 * packs whole lines into <=cap chunks, hard-slicing any single over-long line.
 */
export function splitStateIntoAnchors(md: string, cap = ANCHOR_CAP): string[] {
  const text = md.trim();
  if (!text) return [];
  const out: string[] = [];
  const pushPacked = (block: string): void => {
    let buf = "";
    for (const line of block.split("\n")) {
      if (buf && buf.length + 1 + line.length > cap) {
        out.push(buf);
        buf = line;
      } else {
        buf = buf ? `${buf}\n${line}` : line;
      }
      while (buf.length > cap) {
        out.push(buf.slice(0, cap));
        buf = buf.slice(cap);
      }
    }
    if (buf) out.push(buf);
  };
  // Split at each top-level `## ` header (the frontmatter + title stay in block 0).
  for (const section of text.split(/\n(?=## )/)) {
    const s = section.trim();
    if (!s) continue;
    if (s.length <= cap) out.push(s);
    else pushPacked(s);
  }
  return out;
}

/**
 * Top brand/voice snippets for a generation query (the objective, or the idea
 * hook). Fail-open: no KB / empty query / a thrown search all yield []. The KB
 * returns [] for an empty query, so we fall back to a generic brand probe.
 */
export async function loadBrandContext(kb: VaultKb | null, query: string | null, topK = 4): Promise<string[]> {
  if (!kb) return [];
  const q = (query ?? "").trim() || "brand voice product who we are what we do";
  try {
    const hits = await kb.search(q, topK);
    return hits.map((h) => h.snippet).filter((s): s is string => Boolean(s));
  } catch {
    return [];
  }
}

/**
 * Like loadBrandContext, but PREFERS the generated personal-brand-state.md artifact
 * when present: it computes the normal BM25 brand context, then tries to read the
 * artifact at `statePath` and, on success, unshifts it (split into anchor-sized
 * pieces so the drafter's 400-char clip can't truncate it) AHEAD of the BM25
 * anchors — the operator's distilled "who I am + what performs for me" leads the
 * grounding. Fail-open exactly like loadBrandContext: no statePath / absent file /
 * read error / empty artifact → the base array is returned unchanged (byte-identical).
 */
export async function loadBrandContextPreferringState(
  kb: VaultKb | null,
  query: string | null,
  statePath: string | null,
  topK = 4,
): Promise<string[]> {
  const base = await loadBrandContext(kb, query, topK);
  if (!statePath) return base;
  try {
    const md = await readFile(statePath, "utf8");
    const anchors = splitStateIntoAnchors(md);
    if (anchors.length === 0) return base;
    return [...anchors, ...base];
  } catch {
    return base;
  }
}

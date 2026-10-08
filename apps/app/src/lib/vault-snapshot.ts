import "server-only";
import { VAULT_EDIT_MAX_CHARACTERS } from "@noelle/contracts";
import { isSafeVaultPath, readVaultSource, resolveVaultRoot, scanVaultMarkdown, vaultRootIdentity, VAULT_COMPLETE_MAX_BYTES, type VaultFileBasis } from "./vault-fs";

export type VaultRefreshReason = "partial" | "unseen" | "unavailable" | "too_large" | "invalid_encoding" | "changed" | "no_vault";
export interface VaultSnapshot {
  digest: string | null;
  /** Server-only bases for complete source text actually included in the prompt. */
  bases: Record<string, VaultFileBasis>;
  refreshReasons: Record<string, VaultRefreshReason>;
  /** Upper bound admitted for source reads, including unavailable read attempts. */
  byteAllowance: number;
}

const KEY_HINTS = ["voice-spec", "voice", "brand", "tone", "writing-rules", "banned", "pillar", "cadence", "style", "00-vault-map"];
const DIGEST_CHARACTERS = 7_000;
const ORDINARY_BYTES = 32 * 1024;
const PER_FILE_CHARACTERS = 1200;
const PREFIX_BYTES = PER_FILE_CHARACTERS * 4;
const PARTIAL_NOTICE = "This context is partial. Unshown files may exist; snippets are not complete files.";

/** Capture the exact shown sources before generation; private bases never enter the digest. */
export async function prepareVaultSnapshot(boundRoot: string | null, requestedPath?: string): Promise<VaultSnapshot> {
  const snapshot: VaultSnapshot = { digest: null, bases: {}, refreshReasons: {}, byteAllowance: 0 };
  const root = await resolveVaultRoot(boundRoot);
  if (!root) {
    if (requestedPath) snapshot.refreshReasons[requestedPath] = "no_vault";
    return snapshot;
  }
  const rootIdentity = await vaultRootIdentity(root);
  const scan = await scanVaultMarkdown(root);
  let compact = `Vault context\n${PARTIAL_NOTICE}\nMarkdown files${scan.partial ? " (partial scan)" : ""}:`;
  let shownPaths = 0;
  for (const path of scan.files.slice(0, 80)) {
    const line = `\n  - ${path}`;
    if (compact.length + line.length > 2400) break;
    compact += line;
    shownPaths += 1;
  }
  if (shownPaths < scan.files.length || scan.partial) compact += "\n…file listing is partial.";
  let remainingBytes = ORDINARY_BYTES;
  for (const path of scan.files.filter((file) => KEY_HINTS.some((hint) => file.toLowerCase().includes(hint)))) {
    const reserved = `\n\n### ${path} (complete file)\n`;
    const available = DIGEST_CHARACTERS - compact.length - reserved.length - 32;
    if (available <= 0 || remainingBytes === 0) break;
    const maxBytes = Math.min(PREFIX_BYTES, remainingBytes);
    remainingBytes -= maxBytes;
    snapshot.byteAllowance += maxBytes;
    const source = await readVaultSource(root, path, { maxBytes, prefix: true });
    if (source.kind !== "file") {
      snapshot.refreshReasons[path] = source.kind === "missing" ? "unavailable" : source.kind;
      continue;
    }
    const complete = source.complete && source.text.length <= Math.min(PER_FILE_CHARACTERS, available);
    const text = complete ? source.text : source.text.slice(0, Math.min(PER_FILE_CHARACTERS, available));
    compact += `\n\n### ${path} (${complete ? "complete file" : "partial snippet"})\n${text}${complete ? "" : "\n…partial snippet."}`;
    if (complete && isSafeVaultPath(path) && path.length <= 300) {
      snapshot.bases[path] = { version: 1, path, rootIdentity, exists: true, contentSha256: source.contentSha256, fileIdentity: source.identity };
    } else snapshot.refreshReasons[path] = "partial";
  }
  snapshot.digest = scan.files.length || scan.partial ? compact : null;
  if (requestedPath && isSafeVaultPath(requestedPath) && requestedPath.length <= 300) {
    snapshot.byteAllowance += VAULT_COMPLETE_MAX_BYTES;
    const source = await readVaultSource(root, requestedPath, { maxBytes: VAULT_COMPLETE_MAX_BYTES });
    if (source.kind === "file" && source.complete && source.text.length <= VAULT_EDIT_MAX_CHARACTERS) {
      snapshot.bases[requestedPath] = { version: 1, path: requestedPath, rootIdentity, exists: true, contentSha256: source.contentSha256, fileIdentity: source.identity };
      delete snapshot.refreshReasons[requestedPath];
      snapshot.digest = `${compact}\n\nComplete file for this requested edit: ${requestedPath}\n${source.text}`;
    } else if (source.kind === "missing") {
      snapshot.bases[requestedPath] = { version: 1, path: requestedPath, rootIdentity, exists: false };
      snapshot.digest = `${compact}\n\nRequested path observed absent: ${requestedPath}`;
    } else {
      delete snapshot.bases[requestedPath];
      snapshot.refreshReasons[requestedPath] = source.kind === "file" ? "too_large" : source.kind;
      snapshot.digest = `${compact}\n\nComplete source is unavailable for the requested path: ${requestedPath}`;
    }
  }
  return snapshot;
}

/** Compact vault context without exposing the private write bases. */
export async function buildVaultDigest(boundRoot: string | null): Promise<string | null> {
  return (await prepareVaultSnapshot(boundRoot)).digest;
}

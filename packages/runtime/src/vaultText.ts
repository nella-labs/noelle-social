import { toUSVString } from "node:util";
import { HttpBodyError } from "./boundedHttp.js";

export const VAULT_TEXT_MAX_BYTES = 4 * 1024 * 1024;

export class VaultSourceEncodingError extends Error {
  constructor() { super("Invalid vault source encoding"); this.name = "VaultSourceEncodingError"; }
}

/** Validates complete source text before allocating upload bytes. */
export function assertVaultText(body: string): void {
  if (Buffer.byteLength(body, "utf8") > VAULT_TEXT_MAX_BYTES) throw new RangeError("Vault source exceeds its byte limit");
  if (toUSVString(body) !== body) throw new VaultSourceEncodingError();
}

/** A bounded prefix may end inside a codepoint; complete files must decode exactly. */
export function decodeVaultText(bytes: Uint8Array, options: { complete?: boolean } = {}): string {
  if (!(bytes instanceof Uint8Array)) throw new Error("Invalid vault source body");
  if (bytes.byteLength > VAULT_TEXT_MAX_BYTES) throw new HttpBodyError("body_too_large", "Vault source exceeds its byte limit");
  try {
    return new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes, { stream: options.complete === false });
  } catch { throw new VaultSourceEncodingError(); }
}

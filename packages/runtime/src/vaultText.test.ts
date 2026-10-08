import { expect, it } from "vitest";
import { assertVaultText, decodeVaultText, VAULT_TEXT_MAX_BYTES, VaultSourceEncodingError } from "./vaultText.js";

it("preserves valid complete UTF8 source including its BOM and multibyte characters", () => {
  const text = "\ufeffshipping 🚀"; assertVaultText(text);
  expect(decodeVaultText(Buffer.from(text))).toBe(text);
});
it("allows an intentional bounded prefix to end inside a codepoint without repairing it", () => {
  const full = Buffer.from("shipping 🚀"), prefix = full.subarray(0, full.length - 1);
  expect(decodeVaultText(prefix, { complete: false })).toBe("shipping ");
  expect(() => decodeVaultText(prefix)).toThrow(VaultSourceEncodingError);
});
it("rejects invalid interior bytes even in intentional prefix mode", () => {
  expect(() => decodeVaultText(Buffer.from([115, 255]), { complete: false })).toThrow(VaultSourceEncodingError);
});
it("rejects malformed UTF16 source instead of uploading replacement characters", () => {
  expect(() => assertVaultText("shipping\ud800")).toThrow(VaultSourceEncodingError);
});
it("applies the shared source byte cap to complete bodies and prefix requests", () => {
  const bytes = Buffer.alloc(VAULT_TEXT_MAX_BYTES + 1);
  for (const complete of [true, false]) {
    expect(() => decodeVaultText(bytes, { complete })).toThrow(/byte limit/);
  }
  expect(() => assertVaultText("x".repeat(VAULT_TEXT_MAX_BYTES + 1))).toThrow(/byte limit/);
});

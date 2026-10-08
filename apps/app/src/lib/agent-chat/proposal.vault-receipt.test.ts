import { expect, test } from "vitest";
import { bindVaultEdit, parseStoredVaultEdit, publicVaultEditReceipt } from "./proposal";

const proposal = { path: "voice-spec.md", content: "Exact proposed contents.\r\n ", summary: "Keep factual rules." };
const messageId = "00000000-0000-4000-8000-000000000101";
const basis = {
  version: 1 as const, path: proposal.path, rootIdentity: "a".repeat(64), exists: true,
  contentSha256: "b".repeat(64), fileIdentity: { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" },
};
const snapshot = { digest: "Complete source", bases: { [proposal.path]: basis }, refreshReasons: {}, byteAllowance: 10 };

test("only the server's shown source can bind an eligible durable edit", () => {
  const stored = bindVaultEdit(proposal, snapshot, "cmo");
  expect(stored).toMatchObject({ version: 1, agentRole: "cmo", proposal, basis });
  const receipt = publicVaultEditReceipt(stored, messageId);
  expect(receipt).toEqual({ messageId, eligible: true, refreshReason: null });
  expect(JSON.stringify(receipt)).not.toContain(basis.rootIdentity);
  expect(JSON.stringify(receipt)).not.toContain(basis.contentSha256);
  expect(JSON.stringify(receipt)).not.toContain("fileIdentity");
});

test("an answer without persisted message identity cannot become actionable", () => {
  expect(publicVaultEditReceipt(bindVaultEdit(proposal, snapshot, "cmo"), null)).toEqual({ messageId: null, eligible: false, refreshReason: "not_saved" });
});

test("unseen and partial files cannot borrow an eligible basis", () => {
  const partial = bindVaultEdit(proposal, { ...snapshot, bases: {}, refreshReasons: { [proposal.path]: "partial" as const } }, "cmo");
  expect(publicVaultEditReceipt(partial, messageId)).toMatchObject({ eligible: false, refreshReason: "partial" });
  const unseen = bindVaultEdit(proposal, { ...snapshot, bases: {}, refreshReasons: {} }, "cmo");
  expect(publicVaultEditReceipt(unseen, messageId)).toMatchObject({ eligible: false, refreshReason: "unseen" });
});

test("legacy raw proposal rows remain reviewable and require fresh source", () => {
  const stored = parseStoredVaultEdit(proposal);
  expect(stored?.proposal).toEqual(proposal);
  expect(publicVaultEditReceipt(stored!, messageId)).toMatchObject({ eligible: false, refreshReason: "legacy" });
});

test("invalid or inconsistent private bases cannot authorize a stored proposal", () => {
  const stored = bindVaultEdit(proposal, snapshot, "cmo");
  for (const invalid of [{ ...basis, path: "other.md" }, { ...basis, exists: true, contentSha256: null }, { ...basis, fileIdentity: { ...basis.fileIdentity, ino: {} } }]) {
    const parsed = parseStoredVaultEdit({ ...stored, basis: invalid });
    expect(parsed === null || publicVaultEditReceipt(parsed, messageId).eligible === false).toBe(true);
  }
});

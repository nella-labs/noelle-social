import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { prepareVaultSnapshot } from "./vault-snapshot";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vault-snapshot-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("a complete shown source keeps exact whitespace and CRLF in its private basis", async () => {
  const text = "  Keep facts.\r\n\r\n ";
  await writeFile(join(dir, "voice-spec.md"), text);
  const snapshot = await prepareVaultSnapshot(dir);
  expect(snapshot.digest).toContain(text);
  expect(snapshot.bases["voice-spec.md"]).toMatchObject({
    version: 1, path: "voice-spec.md", exists: true,
    contentSha256: createHash("sha256").update(Buffer.from(text)).digest("hex"),
  });
  expect(snapshot.bases["voice-spec.md"]?.fileIdentity?.ino).toMatch(/^\d+$/);
  expect(snapshot.digest).not.toContain(snapshot.bases["voice-spec.md"]?.rootIdentity);
});

test("a large shown prefix cannot issue a complete-file basis", async () => {
  await writeFile(join(dir, "voice-spec.md"), "x".repeat(8 * 1024 * 1024));
  const snapshot = await prepareVaultSnapshot(dir);
  expect(snapshot.digest).toContain("voice-spec.md");
  expect(snapshot.digest).toContain("partial");
  expect(snapshot.digest!.length).toBeLessThanOrEqual(7_000);
  expect(snapshot.byteAllowance).toBeLessThanOrEqual(32 * 1024);
  expect(snapshot.bases["voice-spec.md"]).toBeUndefined();
  expect(snapshot.refreshReasons["voice-spec.md"]).toBe("partial");
});

test("only an explicitly requested missing path can receive a creation basis", async () => {
  const ordinary = await prepareVaultSnapshot(dir);
  expect(ordinary.bases["new-rules.md"]).toBeUndefined();
  const requested = await prepareVaultSnapshot(dir, "new-rules.md");
  expect(requested.bases["new-rules.md"]).toMatchObject({ exists: false, path: "new-rules.md" });
  expect(requested.digest).toContain("new-rules.md");
  expect(requested.digest).toContain("absent");
  expect((await prepareVaultSnapshot(dir, "../outside.md")).bases).toEqual({});
});

test("explicit refresh includes an exact complete multibyte file up to the edit limit", async () => {
  const text = "é".repeat(50_000);
  await writeFile(join(dir, "complete.md"), text);
  const snapshot = await prepareVaultSnapshot(dir, "complete.md");
  expect(snapshot.digest).toContain(text);
  expect(snapshot.bases["complete.md"]?.exists).toBe(true);
  expect(snapshot.byteAllowance).toBeLessThanOrEqual(200_000 + 32 * 1024);
  await writeFile(join(dir, "complete.md"), "é".repeat(50_001));
  const large = await prepareVaultSnapshot(dir, "complete.md");
  expect(large.bases["complete.md"]).toBeUndefined();
  expect(large.refreshReasons["complete.md"]).toBe("too_large");
});

test("invalid UTF-8 and files not shown in ordinary context cannot mint bases", async () => {
  await writeFile(join(dir, "voice-spec.md"), Buffer.from([0xff, 0xfe]));
  await writeFile(join(dir, "unseen.md"), "Not part of the ordinary digest.");
  const snapshot = await prepareVaultSnapshot(dir);
  expect(snapshot.bases["voice-spec.md"]).toBeUndefined();
  expect(snapshot.bases["unseen.md"]).toBeUndefined();
  expect(snapshot.refreshReasons["voice-spec.md"]).toBe("invalid_encoding");
});

test("file-tree text and omission labels fit within the compact context budget", async () => {
  await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(dir, `${String(i).padStart(3, "0")}-${"a".repeat(230)}.md`), "Fixture")));
  const snapshot = await prepareVaultSnapshot(dir);
  expect(snapshot.digest!.length).toBeLessThanOrEqual(7_000);
  expect(snapshot.digest).toContain("partial");
});

test("an empty existing file is distinct from a requested absent file", async () => {
  await writeFile(join(dir, "empty.md"), "");
  const snapshot = await prepareVaultSnapshot(dir, "empty.md");
  expect(snapshot.bases["empty.md"]).toMatchObject({ exists: true, contentSha256: createHash("sha256").update("").digest("hex") });
  expect((await prepareVaultSnapshot(null, "empty.md")).bases).toEqual({});
});
test("a UTF-8 byte order mark stays part of the exact complete shown text", async () => {
  const text = "\uFEFFKeep the original formatting.\r\n ";
  await writeFile(join(dir, "voice-spec.md"), text);
  const snapshot = await prepareVaultSnapshot(dir);
  expect(snapshot.digest).toContain(text);
  expect(snapshot.bases["voice-spec.md"]?.contentSha256).toBe(createHash("sha256").update(text).digest("hex"));
});

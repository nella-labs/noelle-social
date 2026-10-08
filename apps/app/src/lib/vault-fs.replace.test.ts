import { afterEach, beforeEach, expect, test } from "vitest";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeVaultFile } from "./vault-fs";
import { prepareVaultSnapshot } from "./vault-snapshot";

let dir = "";
const path = "voice-spec.md";
const original = "Original complete rules.\r\n ";
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vault-replace-")); await writeFile(join(dir, path), original); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function replace(content: string, options: Record<string, unknown> = {}) {
  const basis = (await prepareVaultSnapshot(dir)).bases[path];
  return (extra: Record<string, unknown> = {}) => Reflect.apply(writeVaultFile, undefined, [dir, path, content, {
    basis, assertActive: async () => {}, rootStillBound: async () => true, ...options, ...extra,
  }]);
}
test("rejects a changed source and leaves the current bytes intact", async () => {
  const run = await replace("Proposed replacement.");
  await writeFile(join(dir, path), "Newer saved rules.");
  expect(await run()).toEqual({ ok: false, error: "conflict" });
  expect(await readFile(join(dir, path), "utf8")).toBe("Newer saved rules.");
});
test("a lost lease before target mutation preserves the source and removes owned temporary files", async () => {
  const run = await replace("Proposed replacement.", { assertActive: async () => { throw new Error("lease lost"); } });
  expect((await run()).ok).toBe(false);
  expect(await readFile(join(dir, path), "utf8")).toBe(original);
  expect(await readdir(dir)).toEqual([path]);
});
test("a changed root binding cannot authorize a replacement", async () => {
  const run = await replace("Proposed replacement.", { rootStillBound: async () => false });
  expect(await run()).toEqual({ ok: false, error: "refresh_required" });
  expect(await readFile(join(dir, path), "utf8")).toBe(original);
});
test("an exact desired-byte replay succeeds without replacing the observed file again", async () => {
  const run = await replace("Proposed replacement.");
  expect(await run()).toEqual({ ok: true });
  const before = await stat(join(dir, path), { bigint: true });
  expect(await run()).toEqual({ ok: true });
  const after = await stat(join(dir, path), { bigint: true });
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeNs).toBe(before.mtimeNs);
});
test("a confirmed atomic replacement preserves file mode and complete Unicode formatting", async () => {
  await chmod(join(dir, path), 0o640);
  const content = "\uFEFF é\r\n\r\n ";
  const run = await replace(content);
  expect(await run()).toEqual({ ok: true });
  expect(await readFile(join(dir, path), "utf8")).toBe(content);
  expect((await stat(join(dir, path))).mode & 0o777).toBe(0o640);
});
test("atomic replacement retains the existing file's write-permission policy", async () => {
  await chmod(join(dir, path), 0o444);
  const run = await replace("Proposed replacement.");
  expect((await run()).ok).toBe(false);
  expect(await readFile(join(dir, path), "utf8")).toBe(original);
});

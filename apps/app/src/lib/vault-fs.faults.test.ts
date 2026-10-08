import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const state = vi.hoisted(() => ({ failWrite: false, changeRead: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const { writeFileSync } = await import("node:fs");
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (state.failWrite && String(args[0]).includes(".noelle-vault-")) handle.writeFile = async () => { throw new Error("fixture write failure"); };
    if (state.changeRead && String(args[0]).endsWith("voice-spec.md")) {
      const create = handle.createReadStream.bind(handle);
      handle.createReadStream = (...options) => {
        const stream = create(...options);
        stream.once("data", () => { writeFileSync(String(args[0]), "Changed during the captured read."); });
        return stream;
      };
    }
    return handle;
  } };
});
import { writeVaultFile } from "./vault-fs";
import { prepareVaultSnapshot } from "./vault-snapshot";
let dir = "";
const path = "voice-spec.md", original = "Complete original rules.";
beforeEach(async () => { state.failWrite = false; state.changeRead = false; dir = await mkdtemp(join(tmpdir(), "vault-faults-")); await writeFile(join(dir, path), original); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
test("a failed temporary write leaves original bytes intact and awaits owned-file cleanup", async () => {
  const basis = (await prepareVaultSnapshot(dir)).bases[path]!;
  state.failWrite = true;
  expect(await writeVaultFile(dir, path, "Proposed replacement.", { basis, assertActive: async () => {}, rootStillBound: async () => true })).toEqual({ ok: false, error: "write_failed" });
  expect(await readFile(join(dir, path), "utf8")).toBe(original);
  expect(await readdir(dir)).toEqual([path]);
});
test("a file changed during the actual stream read never receives an eligible captured basis", async () => {
  state.changeRead = true;
  const snapshot = await prepareVaultSnapshot(dir);
  expect(snapshot.bases[path]).toBeUndefined();
  expect(snapshot.refreshReasons[path]).toBe("changed");
});

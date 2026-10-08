import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const f = vi.hoisted(() => ({
  read: vi.fn(),
  watch: vi.fn(),
  close: vi.fn(),
  handlers: new Map<string, (path: string) => void>(),
}));
vi.mock("node:fs/promises", () => ({ readFile: f.read }));
vi.mock("chokidar", () => ({ default: { watch: f.watch } }));
import { startWatcher } from "./watch.js";
import type { MirrorStorage } from "./mirror.js";

const root = "/inert-vault-fixture",
  path = `${root}/note.md`;
let watchers: Array<ReturnType<typeof startWatcher>>, releases: Array<() => void>;
beforeEach(() => {
  vi.useFakeTimers();
  f.handlers.clear();
  f.read.mockReset();
  f.watch.mockReset();
  f.close.mockReset().mockResolvedValue(undefined);
  f.watch.mockImplementation(() => ({
    on: (event: string, fn: (path: string) => void) => {
      f.handlers.set(event, fn);
    },
    close: f.close,
  }));
  const blocked = () => {
    throw Error("Provider traffic forbidden in watcher fixture");
  };
  vi.stubGlobal("fetch", blocked);
  for (const network of [http, https])
    for (const method of ["request", "get"] as const)
      vi.spyOn(network, method).mockImplementation(blocked);
  watchers = [];
  releases = [];
});
afterEach(async () => {
  releases.forEach((release) => release());
  await vi.runAllTimersAsync();
  for (const watcher of watchers) await watcher.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
}
function start(writeText: MirrorStorage["writeText"] = vi.fn(async () => {}), prune = false) {
  const storage = { writeText, delete: vi.fn(async () => {}) },
    log = vi.fn();
  const readRemote = vi.fn(async () =>
    ["note.md", "a.md", "b.md", "c.md"].map((relPath) => ({ relPath, md5: "same" })),
  );
  const onFailure = vi.fn();
  const watcher = startWatcher({
    vaultDir: root,
    debounceMs: 50,
    prune,
    log,
    deps: { bucket: "inert", prefix: "fixture/", deleteGuardPct: 25, storage, readLocal: f.read },
    readRemote,
    onFailure,
  });
  watchers.push(watcher);
  return { watcher, storage, log, readRemote, onFailure };
}
const emit = (event: string, filename = path) => f.handlers.get(event)?.(filename);

test("old in-flight body cannot replace a newer saved body", async () => {
  const gate = deferred(),
    commits: string[] = [];
  let remote = "";
  f.read.mockResolvedValueOnce("old body").mockResolvedValueOnce("fresh body");
  const write = vi.fn(async (args: { filename: string; body: string }) => {
    if (args.body === "old body") await gate.promise;
    remote = args.body;
    commits.push(args.body);
  });
  start(write);
  emit("change");
  await vi.advanceTimersByTimeAsync(50);
  emit("change");
  await vi.advanceTimersByTimeAsync(50);
  gate.release();
  await vi.runAllTimersAsync();
  expect(remote, `commit order: ${JSON.stringify(commits)}`).toBe("fresh body");
});
test("close retains the latest already-coalesced pending save", async () => {
  f.read.mockResolvedValue("latest body");
  const { watcher, storage } = start();
  emit("change");
  emit("change");
  emit("change");
  await watcher.close();
  expect(storage.writeText).toHaveBeenCalledExactlyOnceWith({
    filename: "note.md",
    body: "latest body",
  });
});
test("normal rapid saves coalesce before dispatch", async () => {
  f.read.mockResolvedValue("latest body");
  const { storage } = start();
  for (let i = 0; i < 30; i++) emit("change");
  await vi.advanceTimersByTimeAsync(50);
  expect(storage.writeText).toHaveBeenCalledExactlyOnceWith({
    filename: "note.md",
    body: "latest body",
  });
});
test("additive mode ignores local unlink", async () => {
  const { storage } = start();
  emit("unlink");
  await vi.advanceTimersByTimeAsync(50);
  expect(storage.delete).not.toHaveBeenCalled();
  expect(storage.writeText).not.toHaveBeenCalled();
});
test("nonmarkdown files do not enter the provider", async () => {
  const { storage } = start(undefined, true);
  emit("change", `${root}/image.png`);
  emit("unlink", `${root}/image.png`);
  await vi.advanceTimersByTimeAsync(50);
  expect(f.read).not.toHaveBeenCalled();
  expect(storage.writeText).not.toHaveBeenCalled();
  expect(storage.delete).not.toHaveBeenCalled();
});
test("a failed upload does not stop a later healthy save", async () => {
  f.read.mockRejectedValueOnce(Error("inert file unavailable")).mockResolvedValueOnce("recovered");
  const { storage, log } = start();
  emit("change");
  await vi.advanceTimersByTimeAsync(50);
  emit("change");
  await vi.advanceTimersByTimeAsync(50);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("upload failed"));
  expect(storage.writeText).toHaveBeenCalledExactlyOnceWith({
    filename: "note.md",
    body: "recovered",
  });
});

test("a queued unlink waits for the older upload to settle", async () => {
  const gate = deferred(),
    order: string[] = [];
  f.read.mockResolvedValue("body");
  const { storage } = start(
    vi.fn(async () => {
      await gate.promise;
      order.push("write");
    }),
    true,
  );
  storage.delete.mockImplementation(async () => {
    order.push("delete");
  });
  emit("change");
  await vi.advanceTimersByTimeAsync(50);
  emit("unlink");
  await vi.advanceTimersByTimeAsync(50);
  expect(storage.delete).not.toHaveBeenCalled();
  gate.release();
  await vi.runAllTimersAsync();
  expect(order).toEqual(["write", "delete"]);
});
test("the latest pending create replaces an unlink without deleting", async () => {
  f.read.mockResolvedValue("recreated");
  const { storage, readRemote } = start(undefined, true);
  emit("unlink");
  emit("add");
  await vi.advanceTimersByTimeAsync(50);
  expect(storage.writeText).toHaveBeenCalledExactlyOnceWith({
    filename: "note.md",
    body: "recreated",
  });
  expect(storage.delete).not.toHaveBeenCalled();
  expect(readRemote).not.toHaveBeenCalled();
});
test("a failed fresh complete listing authorizes zero prune deletes", async () => {
  const { storage, readRemote, log } = start(undefined, true);
  readRemote.mockRejectedValueOnce(Error("inert listing unavailable"));
  emit("unlink");
  await vi.advanceTimersByTimeAsync(50);
  expect(storage.delete).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("delete batch failed"));
});
test("close is idempotent and waits for active plus pending work", async () => {
  const gate = deferred();
  f.read.mockResolvedValueOnce("old").mockResolvedValueOnce("latest");
  const write = vi.fn(async ({ body }: { filename: string; body: string }) => {
    if (body === "old") await gate.promise;
  });
  const { watcher } = start(write);
  emit("change");
  await vi.advanceTimersByTimeAsync(50);

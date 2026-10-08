import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const f = vi.hoisted(() => ({
  read: vi.fn(),
  scan: vi.fn(),
  getFiles: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  watch: vi.fn(),
  close: vi.fn(),
  handlers: new Map<string, (path: string) => void>(),
}));
vi.mock("node:fs/promises", () => ({ readFile: f.read }));
vi.mock("chokidar", () => ({ default: { watch: f.watch } }));
vi.mock("./scan.js", () => ({ scanVault: f.scan }));
vi.mock("@noelle/runtime/vault-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@noelle/runtime/vault-storage")>()),
  createGcsStorage: async () => ({
    bucket: () => ({ getFiles: f.getFiles, file: () => ({ save: f.write, delete: f.remove }) }),
  }),
}));
const root = "/inert-vault-entry",
  files = ["a.md", "b.md", "c.md", "d.md"];
let originalArgv: string[],
  signals: Map<string, () => Promise<void>>,
  release: (() => void) | undefined;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  f.handlers.clear();
  signals = new Map();
  release = undefined;
  for (const fn of [f.read, f.scan, f.getFiles, f.write, f.remove, f.watch, f.close])
    fn.mockReset();
  f.read.mockResolvedValue("synthetic body");
  f.write.mockResolvedValue(undefined);
  f.remove.mockResolvedValue(undefined);
  f.close.mockResolvedValue(undefined);
  f.scan.mockResolvedValue(files.map((relPath) => ({ relPath, md5: "same" })));
  f.getFiles.mockResolvedValue([
    files.map((filename) => ({
      name: `fixture/${filename}`,
      metadata: { size: "8", updated: "2026-10-06T00:00:00Z", md5Hash: "same" },
    })),
  ]);
  f.watch.mockImplementation(() => ({
    on: (event: string, fn: (path: string) => void) => {
      f.handlers.set(event, fn);
    },
    close: f.close,
  }));
  vi.stubEnv("VAULT_DIR", root);
  vi.stubEnv("NOELLE_VAULT_BUCKET", "inert-bucket");
  vi.stubEnv("NOELLE_VAULT_PREFIX", "fixture/");
  vi.stubEnv("VAULT_SYNC_DELETE_GUARD_PCT", "25");
  vi.stubEnv("VAULT_SYNC_DEBOUNCE_MS", "50");
  originalArgv = process.argv;
  const blocked = () => {
    throw Error("Provider traffic forbidden in daemon entry fixture");
  };
  vi.stubGlobal("fetch", blocked);
  for (const network of [http, https])
    for (const method of ["request", "get"] as const)
      vi.spyOn(network, method).mockImplementation(blocked);
  const realOn = process.on;
  vi.spyOn(process, "on").mockImplementation(function (
    this: NodeJS.Process,
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ) {
    if (event === "SIGINT" || event === "SIGTERM") {
      signals.set(event, listener as () => Promise<void>);
      return process;
    }
    return Reflect.apply(realOn, this, [event, listener]);
  });
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  release?.();
  await vi.runAllTimersAsync();
  await signals.get("SIGTERM")?.();
  process.argv = originalArgv;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function entry(flags: string[] = []) {
  process.argv = ["node", "inert-daemon", ...flags];
  await import("./index.js");
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
const unlink = (filename: string) => f.handlers.get("unlink")?.(`${root}/${filename}`);
test("continuous prune applies the configured mass-delete guard", async () => {
  await entry(["--prune"]);
  expect(f.watch).toHaveBeenCalledTimes(1);
  files.slice(0, 3).forEach(unlink);
  await vi.advanceTimersByTimeAsync(50);
  expect(f.remove).not.toHaveBeenCalled();
});
test("actual SIGTERM does not report exit while a write still runs", async () => {
  f.write.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await entry();
  f.handlers.get("change")?.(`${root}/a.md`);
  await vi.advanceTimersByTimeAsync(50);
  expect(f.write).toHaveBeenCalledTimes(1);
  const shutdown = signals.get("SIGTERM")!();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  try {
    expect(process.exit).not.toHaveBeenCalled();
  } finally {
    release?.();
    await shutdown;
  }
});
test("explicit force preserves intentional pruning", async () => {
  await entry(["--prune", "--force"]);
  files.slice(0, 3).forEach(unlink);
  await vi.advanceTimersByTimeAsync(50);
  expect(f.remove).toHaveBeenCalledTimes(3);
});
test("startup mass-delete guard still withholds without force", async () => {
  f.scan.mockResolvedValue([]);
  await entry(["--prune"]);
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.watch).toHaveBeenCalledTimes(1);
});
test("once-only sync never starts a continuous watcher", async () => {
  await entry(["--once"]);
  expect(f.watch).not.toHaveBeenCalled();
  expect(f.write).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
});

test("a later complete-list page failure never starts uploads, pruning or watching", async () => {
  f.getFiles
    .mockResolvedValueOnce([
      [
        {
          name: "fixture/a.md",
          metadata: {
            size: "8",
            updated: "2026-10-06T00:00:00Z",
          },
        },
      ],
      { pageToken: "more" },
    ])
    .mockRejectedValueOnce(Error("Metadata unavailable"));
  await entry(["--once", "--prune", "--force"]);
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(f.getFiles).toHaveBeenCalledTimes(2);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.watch).not.toHaveBeenCalled();
});

test("a fresh watcher listing failure withholds even forced deletions", async () => {
  await entry(["--prune", "--force"]);
  f.getFiles.mockRejectedValueOnce(Error("Metadata unavailable"));
  files.slice(0, 3).forEach(unlink);
  await vi.advanceTimersByTimeAsync(50);
  expect(f.getFiles).toHaveBeenCalledTimes(2);
  expect(f.remove).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining("delete batch failed"));
});
test("one live unlink at the threshold is allowed", async () => {
  await entry(["--prune"]);
  unlink(files[0]!);
  await vi.advanceTimersByTimeAsync(50);
  expect(f.remove).toHaveBeenCalledTimes(1);
  expect(f.getFiles).toHaveBeenCalledTimes(2);
});
test("repeated shutdown signals share one drain and one successful exit", async () => {
  f.write.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await entry();
  f.handlers.get("change")?.(`${root}/a.md`);
  await vi.advanceTimersByTimeAsync(50);
  const first = signals.get("SIGTERM")!(),
    second = signals.get("SIGINT")!();
  expect(second).toBe(first);
  expect(process.exit).not.toHaveBeenCalled();
  release?.();
  await first;
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
});
test("queue saturation exits unsuccessfully only after accepted writes settle", async () => {
  f.write.mockImplementation(() =>
    f.write.mock.calls.length === 1
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : Promise.resolve(),
  );
  await entry();
  f.handlers.get("change")?.(`${root}/a.md`);
  await vi.advanceTimersByTimeAsync(50);
  for (let i = 0; i < 257; i++) f.handlers.get("change")?.(`${root}/queued-${i}.md`);
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(process.exit).not.toHaveBeenCalled();
  release?.();
  await vi.runAllTimersAsync();
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(f.write).toHaveBeenCalledTimes(257);
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
});

import { describe, expect, it } from "vitest";
import { nativePgDataDirs, parsePostmasterPid, postmasterLockIsStale } from "./postgres.js";

describe("parsePostmasterPid", () => {
  it("reads the pid from the first line of a real postmaster.pid", () => {
    const content = [
      "1388",
      "/opt/homebrew/var/postgresql@16",
      "1784159710",
      "5432",
      "/tmp",
      "localhost",
      " 70695638     65536",
      "stopping",
    ].join("\n");
    expect(parsePostmasterPid(content)).toBe(1388);
  });

  it("rejects garbage, empty, and non-numeric first lines", () => {
    expect(parsePostmasterPid("")).toBeNull();
    expect(parsePostmasterPid("\n5432")).toBeNull();
    expect(parsePostmasterPid("not-a-pid\n5432")).toBeNull();
    expect(parsePostmasterPid("-5\n")).toBeNull();
    expect(parsePostmasterPid("0\n")).toBeNull();
  });
});

describe("postmasterLockIsStale", () => {
  it("a dead pid is stale", () => {
    expect(postmasterLockIsStale({ alive: false, command: null })).toBe(true);
  });

  it("a recycled pid owned by an unrelated process is stale (the reboot case)", () => {
    // Seen live 2026-07-18: after an unclean reboot, pid 1388 belonged to an
    // Apple audio service, wedging the brew KeepAlive loop for 18+ hours.
    expect(postmasterLockIsStale({ alive: true, command: "AUCrashHandlerService" })).toBe(true);
  });

  it("a live postgres holder is NOT stale", () => {
    expect(postmasterLockIsStale({ alive: true, command: "postgres" })).toBe(false);
    expect(
      postmasterLockIsStale({ alive: true, command: "/opt/homebrew/opt/postgresql@16/bin/postgres" }),
    ).toBe(false);
  });

  it("a live pid whose command could not be read is NOT stale (never clear a maybe-live lock)", () => {
    expect(postmasterLockIsStale({ alive: true, command: null })).toBe(false);
  });
});

describe("nativePgDataDirs", () => {
  it("covers Apple Silicon and Intel brew prefixes for the service", () => {
    expect(nativePgDataDirs("postgresql@16")).toEqual([
      "/opt/homebrew/var/postgresql@16",
      "/usr/local/var/postgresql@16",
    ]);
  });
});

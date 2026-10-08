import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sink } from "./sink.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-sink-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const iso = (ms: number) => new Date(ms).toISOString();

describe("Sink logs", () => {
  it("round-trips append + query, newest-last", () => {
    const sink = new Sink({ logDir: dir, maxBytes: 5_000_000 });
    const r = sink.appendLogs({
      source: "x-actuator",
      entries: [
        { at: iso(1_000), msg: "first", level: "info" },
        { at: iso(2_000), msg: "second", level: "error", data: { draftId: "d1" } },
      ],
    });
    expect(r.stored).toBe(2);

    const q = sink.queryLogs({ source: "x-actuator" });
    expect(q.count).toBe(2);
    expect(q.source).toBe("x-actuator");
    expect(q.entries.at(-1)?.msg).toBe("second"); // newest-last
    expect(q.entries.at(-1)?.source).toBe("x-actuator"); // source merged back in
  });

  it("filters by level, grep (msg + data), and sinceMs", () => {
    const sink = new Sink({ logDir: dir, maxBytes: 5_000_000 });
    sink.appendLogs({
      source: "s",
      entries: [
        { at: iso(1_000), msg: "alpha", level: "info", data: { agent: "vega" } },
        { at: iso(2_000), msg: "beta", level: "error", data: { agent: "lyra" } },
        { at: iso(3_000), msg: "gamma", level: "warn" },
      ],
    });

    expect(sink.queryLogs({ source: "s", level: "error" }).count).toBe(1);
    expect(sink.queryLogs({ source: "s", grep: "beta" }).count).toBe(1); // matches msg
    expect(sink.queryLogs({ source: "s", grep: "lyra" }).count).toBe(1); // matches data
    expect(sink.queryLogs({ source: "s", grep: "LYRA" }).count).toBe(1); // case-insensitive
    expect(sink.queryLogs({ source: "s", sinceMs: 2_500 }).count).toBe(1); // only gamma@3000
    expect(sink.queryLogs({ source: "s", limit: 2 }).count).toBe(2); // cap
  });

  it("merges across all sources when no source is given", () => {
    const sink = new Sink({ logDir: dir, maxBytes: 5_000_000 });
    sink.appendLogs({ source: "a", entries: [{ at: iso(1_000), msg: "from-a" }] });
    sink.appendLogs({ source: "b", entries: [{ at: iso(2_000), msg: "from-b" }] });
    const q = sink.queryLogs({});
    expect(q.count).toBe(2);
    expect(q.source).toBeUndefined();
    expect(q.entries.at(-1)?.msg).toBe("from-b"); // newest across sources last
  });

  it("rejects malformed ingest without throwing (stored: 0)", () => {
    const sink = new Sink({ logDir: dir, maxBytes: 5_000_000 });
    expect(sink.appendLogs({ nope: true }).stored).toBe(0);
    expect(sink.appendLogs({ source: "s", entries: [] }).stored).toBe(0); // min(1) violated
  });

  it("rotates to a .1 backup when a source file exceeds the cap", () => {
    const sink = new Sink({ logDir: dir, maxBytes: 300 });
    const big = (ms: number) => ({ at: iso(ms), msg: "x".repeat(120), level: "info" as const });

    sink.appendLogs({ source: "s", entries: [big(1_000)] }); // ~190B, no rotation
    expect(existsSync(join(dir, "s.ndjson.1"))).toBe(false);

    sink.appendLogs({ source: "s", entries: [big(2_000)] }); // 190+190 > 300 → rotate
    expect(existsSync(join(dir, "s.ndjson.1"))).toBe(true);
    expect(existsSync(join(dir, "s.ndjson"))).toBe(true);

    // The rotated backup is still readable through queryLogs.
    const q = sink.queryLogs({ source: "s" });
    expect(q.count).toBe(2);
    expect(q.entries.at(-1)?.at).toBe(iso(2_000));
  });

  it("rejects a path-traversal source on the read path (no arbitrary file read)", () => {
    const sink = new Sink({ logDir: dir, maxBytes: 1_000_000 });
    sink.appendLogs({ source: "s", entries: [{ at: iso(1), msg: "ok", level: "info" }] });
    // A traversal slug fails the slug regex → empty result, never a file outside logDir.
    const q = sink.queryLogs({ source: "../../../../etc/hosts" });
    expect(q.count).toBe(0);
    expect(q.entries).toHaveLength(0);
  });
});

describe("Sink heartbeats", () => {
  it("set/get computes age_ms and stale against the threshold", () => {
    const sink = new Sink({ logDir: dir, maxBytes: 5_000_000 });
    const now = 1_000_000;
    sink.setHeartbeat({ source: "x-actuator", at: iso(now - 100), state: "running" });

    const fresh = sink.getHeartbeats(now, () => 600_000);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.age_ms).toBe(100);
    expect(fresh[0]?.stale).toBe(false);

    const stale = sink.getHeartbeats(now, () => 50); // 50ms threshold, age 100
    expect(stale[0]?.stale).toBe(true);
  });

  it("keeps only the latest heartbeat per source and mirrors it to disk", () => {
    const sink = new Sink({ logDir: dir, maxBytes: 5_000_000 });
    sink.setHeartbeat({ source: "s", at: iso(1_000), state: "idle" });
    sink.setHeartbeat({ source: "s", at: iso(2_000), state: "running" });

    const hb = sink.getHeartbeats(3_000, () => 600_000);
    expect(hb).toHaveLength(1);
    expect(hb[0]?.state).toBe("running");
    expect(existsSync(join(dir, "heartbeats.json"))).toBe(true);

    // A fresh Sink over the same dir reloads the mirrored heartbeat.
    const reloaded = new Sink({ logDir: dir, maxBytes: 5_000_000 });
    expect(reloaded.getHeartbeats(3_000, () => 600_000)[0]?.state).toBe("running");
  });

  it("rejects a malformed heartbeat without throwing (ok: false)", () => {
    const sink = new Sink({ logDir: dir, maxBytes: 5_000_000 });
    expect(sink.setHeartbeat({ source: "s" }).ok).toBe(false); // missing at/state
    expect(sink.setHeartbeat({ source: "s", at: iso(1), state: "banana" }).ok).toBe(false);
  });
});

describe("Sink sources", () => {
  it("reports the sources seen since boot", () => {
    const sink = new Sink({ logDir: dir, maxBytes: 5_000_000 });
    sink.appendLogs({ source: "x-actuator", entries: [{ at: iso(1), msg: "hi" }] });
    sink.setHeartbeat({ source: "linkedin-actuator", at: iso(1), state: "idle" });
    expect(sink.sources()).toEqual(["linkedin-actuator", "x-actuator"]);
  });
});

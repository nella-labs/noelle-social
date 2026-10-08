import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cleanupPrivateReviewTraces, writePrivateReviewTrace, type PrivateReviewAttempt } from "./private-review-trace.js";

const leadId = "11111111-1111-4111-8111-111111111111";
const directory = (home: string) => join(home, ".noelle", "private-review-traces");
const filename = (id = leadId) => `linkedin-${id}.json`;
const attempt = (body: string, index = 0): PrivateReviewAttempt => ({
  attempt: index,
  drafts: [{ kind: "reply", angle: "empathetic", body }],
  verdict: {
    pass: false,
    judgeOk: true,
    judgeProvider: "legacy",
    scores: { voice: 0.3, grounding: 0.4, relevance: 0.5, format: 1, novelty: 1, diversity: 1 },
    reasons: ["too generic"],
    fix: "name a concrete detail",
  },
});

describe("private LinkedIn review trace", () => {
  const homes: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function home(): string {
    const path = mkdtempSync(join(tmpdir(), "noelle-review-trace-unit-"));
    homes.push(path);
    vi.stubEnv("HOME", path);
    return path;
  }

  it("creates no directory unless the exact UUID and browser source are selected", async () => {
    const root = home();
    const args = { leadId, source: "extension_observed", attempts: [attempt("reply")], redactions: [] };
    await writePrivateReviewTrace(args);
    expect(existsSync(directory(root))).toBe(false);
    vi.stubEnv("NOELLE_LINKEDIN_REVIEW_TRACE_LEAD_ID", leadId);
    await writePrivateReviewTrace({ ...args, source: "apify" });
    await writePrivateReviewTrace({ ...args, leadId: "22222222-2222-4222-8222-222222222222" });
    expect(existsSync(directory(root))).toBe(false);
  });

  it("redacts supplied post and author literals from all free text", async () => {
    const root = home();
    vi.stubEnv("NOELLE_LINKEDIN_REVIEW_TRACE_LEAD_ID", leadId);
    await writePrivateReviewTrace({
      leadId,
      source: "extension_observed",
      attempts: [{
        ...attempt("Alice wrote a secret post"),
        verdict: { ...attempt("x").verdict, reasons: ["Alice wrote a secret post"], fix: "quote secret post" },
      }],
      redactions: ["Alice", "secret post"],
    });
    const raw = readFileSync(join(directory(root), filename()), "utf8");
    expect(raw).not.toContain("Alice");
    expect(raw).not.toContain("secret post");
    expect(raw).toContain("[redacted]");
    expect(statSync(join(directory(root), filename())).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory(root))).toEqual([filename()]);
  });

  it("bounds repeated large attempts and clears only expired trace files", async () => {
    const root = home();
    vi.stubEnv("NOELLE_LINKEDIN_REVIEW_TRACE_LEAD_ID", leadId);
    const dir = directory(root);
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, filename("22222222-2222-4222-8222-222222222222"));
    const unrelated = join(dir, "notes.txt");
    writeFileSync(stale, "old");
    writeFileSync(unrelated, "keep");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    utimesSync(unrelated, old, old);
    await cleanupPrivateReviewTraces();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    await writePrivateReviewTrace({
      leadId,
      source: "extension_observed",
      attempts: Array.from({ length: 20 }, (_, i) => ({
        ...attempt("é".repeat(20_000), i),
        verdict: { ...attempt("x").verdict, reasons: ["x".repeat(10_000)], fix: "y".repeat(10_000) },
      })),
      redactions: [],
    });
    const raw = readFileSync(join(dir, filename()));
    const trace = JSON.parse(raw.toString("utf8")) as { attempts: Array<{ attempt: number; drafts: Array<{ body: string }> }> };
    expect(raw.length).toBeLessThanOrEqual(40_000);
    expect(trace.attempts).toHaveLength(6);
    expect(trace.attempts.map((item) => item.attempt)).toEqual([14, 15, 16, 17, 18, 19]);
    expect(trace.attempts[0]?.drafts[0]?.body.length).toBeLessThan(20_000);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("removes a surviving trace after a worker restart before its 24-hour expiry", async () => {
    const root = home();
    const dir = directory(root);
    mkdirSync(dir, { recursive: true });
    const trace = join(dir, filename());
    writeFileSync(trace, "private reply");
    const started = new Date("2026-09-20T12:00:00.000Z");
    const written = new Date(started.getTime() - 60 * 60 * 1000);
    utimesSync(trace, written, written);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(started);

    await cleanupPrivateReviewTraces(); // worker boot; original process timer is gone
    expect(existsSync(trace)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(22 * 60 * 60 * 1000);
    expect(existsSync(trace)).toBe(true);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    const deadline = performance.now() + 1000;
    while (existsSync(trace) && performance.now() < deadline) await delay(10);
    expect(existsSync(trace)).toBe(false);
  });
});

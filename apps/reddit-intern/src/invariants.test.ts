import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// Hard invariants for Orion: it never posts to Reddit and never auto-sends.
// Orion DOES classify (discovery → classifier → drafter), but it has NO send
// worker — these tests fail loudly the moment a write/send path appears.

const here = dirname(fileURLToPath(import.meta.url));

describe("draft-only invariants", () => {
  it("there is NO send worker file (Orion never posts to Reddit)", () => {
    const workers = readdirSync(join(here, "workers")).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    // The quality pipeline: discovery → classifier → drafter. Each as a
    // <kind>.ts entrypoint + its <kind>-tick.ts logic, plus the shared _runtime
    // loop. pattern-breaker-tick.ts is tick logic only — it runs INSIDE the
    // drafter worker (no own entrypoint) and writes rules/alerts, never Reddit.
    // A SEND worker must never exist.
    expect(workers.sort()).toEqual([
      "_runtime.ts",
      "classifier-tick.ts",
      "classifier.ts",
      "discovery-tick.ts",
      "discovery.ts",
      "drafter-tick.ts",
      "drafter.ts",
      "pattern-breaker-tick.ts",
    ]);
    // No send entrypoint or tick logic exists anywhere — Orion never posts.
    for (const banned of ["send.ts", "send-tick.ts"]) {
      expect(workers).not.toContain(banned);
    }
  });
});

// Pause = full stop. Orion's entire pipeline IS the subreddit-watchlist lane, so
// (unlike Vega/Lyra, where the always-on watchlist lane is a priority-people
// SUBSET running alongside a separate keyword lane) keeping it running while
// paused makes "Pause" a no-op. Every worker entrypoint must select ACTIVE-only
// instances; a paused instance must never reach a tick. These guard against the
// always-on-while-paused selector being reintroduced.
describe("pause = full stop invariants", () => {
  const entrypoints = ["discovery.ts", "classifier.ts", "drafter.ts"];

  for (const file of entrypoints) {
    it(`${file} selects active-only instances (paused = full stop)`, () => {
      const src = readFileSync(join(here, "workers", file), "utf8");
      expect(src).toContain("listActiveRedditInternInstances(sql)");
      // The always-on-while-paused selector must not drive any worker loop.
      expect(src).not.toContain("listActiveOrPausedRedditInternInstances");
    });
  }
});

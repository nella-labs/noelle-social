import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLinkedInClient } from "@noelle/linkedin-client";

// Hard invariants for Lyra: it never posts to LinkedIn and never auto-sends.
// Lyra DOES classify (discovery → classifier → drafter + profiler), but it has
// NO send worker — these tests fail loudly the moment a write/send path appears.

const here = dirname(fileURLToPath(import.meta.url));

describe("draft-only invariants", () => {
  it("the LinkedIn client exposes NO write/comment/like/connect/message method", () => {
    const client = createLinkedInClient({ liAt: "fake", fetchImpl: (async () => new Response("")) as never });
    const methods = Object.keys(client);
    // Read-only surface only.
    expect(methods.sort()).toEqual(["connections", "me", "memberPosts", "resolveProfile"]);
    for (const banned of ["comment", "like", "connect", "message", "send", "post", "share", "react"]) {
      expect(methods).not.toContain(banned);
    }
  });

  it("there is NO send worker file (Lyra never posts to LinkedIn)", () => {
    const workers = readdirSync(join(here, "workers")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    // The quality pipeline: discovery → classifier → drafter (+ profiler). Each
    // as a <kind>.ts entrypoint + its <kind>-tick.ts logic, plus the shared
    // _runtime loop. The Intelligence box adds the Engagement Analyst pass
    // (analyst-tick.ts, run inside the profiler worker — no own entrypoint). The
    // Account Feeder adds account-feeder.ts + account-feeder-tick.ts (a manual,
    // cost-gated STYLE-learning pull — it writes the style corpus + ultra
    // profiles, never leads and never a LinkedIn write). The Pattern Breaker adds
    // pattern-breaker-tick.ts (a corpus-level audit that writes anti-pattern
    // rules + operator alerts — never leads, never a LinkedIn write; run inside
    // the drafter worker, no own entrypoint). followup.ts is an on-demand ONE-SHOT
    // (the connection follow-up: scrape a new connection's posts + authored
    // comments and print a brief — it only READS via Apify + drafts, never a
    // LinkedIn write, and has no tick file because it runs once and exits). A
    // classifier now exists; a SEND worker must never.
    expect(workers.sort()).toEqual([
      "_runtime.ts",
      "account-feeder-tick.ts",
      "account-feeder.ts",
      "analyst-tick.ts",
      "classifier-tick.ts",
      "classifier.ts",
      "discovery-tick.ts",
      "discovery.ts",
      "drafter-tick.ts",
      "drafter.ts",
      "followup.ts",
      "ideation-tick.ts",
      "ideation.ts",
      "pattern-breaker-tick.ts",
      "polish-tick.ts",
      "post-drafter-tick.ts",
      "post-drafter.ts",
      "profiler-tick.ts",
      "profiler.ts",
    ]);
    // No send entrypoint or tick logic exists anywhere — Lyra never posts.
    for (const banned of ["send.ts", "send-tick.ts"]) {
      expect(workers).not.toContain(banned);
    }
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { parseIncludeDirs } from "@noelle/runtime";
import { loadEnv, resetEnvForTests } from "./env.js";

const BASE = {
  NOELLE_DATABASE_URL: "postgres://localhost/noelle",
  NOELLE_HMAC_SECRET: "x".repeat(32),
};

function withEnv(extra: Record<string, string>, fn: () => void) {
  const snapshot = { ...process.env };
  Object.assign(process.env, BASE, extra);
  try {
    fn();
  } finally {
    process.env = snapshot;
    resetEnvForTests();
  }
}

describe("loadEnv (linkedin-intern)", () => {
  afterEach(() => resetEnvForTests());

  it("applies the LinkedIn-specific defaults", () => {
    withEnv({}, () => {
      const env = loadEnv();
      expect(env.LINKEDIN_MIN_DELAY_MS).toBe(20_000); // human cadence floor
      expect(env.LINKEDIN_JITTER_MS).toBe(70_000); // 20–90s window with the floor
      expect(env.LINKEDIN_MAX_CALLS_PER_HOUR).toBe(90);
      expect(env.LINKEDIN_ACTIVE_HOURS_START).toBe(7);
      expect(env.LINKEDIN_ACTIVE_HOURS_END).toBe(23);
      expect(env.LINKEDIN_DISCOVERY_LIMIT).toBe(5); // small + gentle
      expect(env.LINKEDIN_PROFILER_LIMIT).toBe(40); // deep history
      expect(env.LINKEDIN_APIFY_REPLY_LEADS).toBe(false);
    });
  });

  it("allows explicit legacy Apify reply-lead sourcing after browser cutover", () => {
    for (const value of ["false", "0"]) {
      withEnv({ LINKEDIN_APIFY_REPLY_LEADS: value }, () => {
        expect(loadEnv().LINKEDIN_APIFY_REPLY_LEADS).toBe(false);
      });
    }
    for (const value of ["true", "1"]) {
      withEnv({ LINKEDIN_APIFY_REPLY_LEADS: value }, () => {
        expect(loadEnv().LINKEDIN_APIFY_REPLY_LEADS).toBe(true);
      });
    }
  });

  it("coerces overrides for the LinkedIn knobs", () => {
    withEnv(
      { LINKEDIN_MIN_DELAY_MS: "3000", LINKEDIN_DISCOVERY_LIMIT: "8", LINKEDIN_PROFILER_LIMIT: "60" },
      () => {
        const env = loadEnv();
        expect(env.LINKEDIN_MIN_DELAY_MS).toBe(3000);
        expect(env.LINKEDIN_DISCOVERY_LIMIT).toBe(8);
        expect(env.LINKEDIN_PROFILER_LIMIT).toBe(60);
      },
    );
  });

  it("knows the four pipeline worker kinds (discovery/classifier/profiler/drafter) but NOT send", () => {
    for (const kind of ["discovery", "classifier", "profiler", "drafter"]) {
      withEnv({ NOELLE_WORKER_KIND: kind }, () => {
        expect(loadEnv().NOELLE_WORKER_KIND).toBe(kind);
      });
    }
    // Lyra never posts to LinkedIn — there is no send worker.
    withEnv({ NOELLE_WORKER_KIND: "send" }, () => {
      expect(() => loadEnv()).toThrow();
    });
  });

  it("applies the quality-pipeline defaults", () => {
    withEnv({}, () => {
      const env = loadEnv();
      expect(env.LINKEDIN_Q_THRESHOLD).toBe(75);
      // 0 = unlimited (no daily extract cap) — governed by goal + backpressure
      // + rate limits instead. Set a positive value to re-impose a hard ceiling.
      expect(env.LINKEDIN_DAILY_EXTRACT_CAP).toBe(0);
      // Watch-lane per-person re-poll cooldown: 4h ⇒ ≤6 profilePosts
      // sweeps/day/person instead of one per 15-min tick (~96/day).
      expect(env.LINKEDIN_WATCHLIST_REPOLL_HOURS).toBe(4);
      // 0 = unlimited on both draft buckets. Drafting is draft-only (it fills the
      // approval queue, never posts), so the write-side pacing is the safety
      // valve; a fixed daily bucket only starved the queue.
      expect(env.LINKEDIN_DAILY_SUBSTANTIAL_CAP).toBe(0);
      expect(env.LINKEDIN_DAILY_LIGHT_CAP).toBe(0);
      expect(env.CLASSIFIER_POLL_MS).toBe(30_000);
      expect(env.CLASSIFIER_BATCH).toBe(10);
    });
  });

  it("coerces overrides for the quality-pipeline knobs", () => {
    withEnv(
      {
        LINKEDIN_Q_THRESHOLD: "80",
        LINKEDIN_DAILY_EXTRACT_CAP: "120",
        LINKEDIN_WATCHLIST_REPOLL_HOURS: "0.5",
        LINKEDIN_DAILY_SUBSTANTIAL_CAP: "40",
        LINKEDIN_DAILY_LIGHT_CAP: "10",
        CLASSIFIER_BATCH: "5",
      },
      () => {
        const env = loadEnv();
        expect(env.LINKEDIN_Q_THRESHOLD).toBe(80);
        expect(env.LINKEDIN_DAILY_EXTRACT_CAP).toBe(120);
        expect(env.LINKEDIN_WATCHLIST_REPOLL_HOURS).toBe(0.5);
        expect(env.LINKEDIN_DAILY_SUBSTANTIAL_CAP).toBe(40);
        expect(env.LINKEDIN_DAILY_LIGHT_CAP).toBe(10);
        expect(env.CLASSIFIER_BATCH).toBe(5);
      },
    );
  });

  it("defaults the intro-DM lane OFF with a daily cap of 5 (live Lyra unchanged)", () => {
    withEnv({}, () => {
      const env = loadEnv();
      expect(env.LINKEDIN_INTRO_DM_ENABLED).toBe(false);
      expect(env.LINKEDIN_INTRO_DM_DAILY_CAP).toBe(5);
    });
  });

  it("parses the intro-DM flags when the operator opts in (and the boolFlag trap)", () => {
    withEnv({ LINKEDIN_INTRO_DM_ENABLED: "true", LINKEDIN_INTRO_DM_DAILY_CAP: "3" }, () => {
      const env = loadEnv();
      expect(env.LINKEDIN_INTRO_DM_ENABLED).toBe(true);
      expect(env.LINKEDIN_INTRO_DM_DAILY_CAP).toBe(3);
    });
    // Boolean('false') trap: 'false'/'0' must NOT enable the lane.
    for (const v of ["false", "0", "", "no"]) {
      withEnv({ LINKEDIN_INTRO_DM_ENABLED: v }, () => {
        expect(loadEnv().LINKEDIN_INTRO_DM_ENABLED).toBe(false);
      });
    }
    // cap=0 is valid (disables the lane via the claim short-circuit).
    withEnv({ LINKEDIN_INTRO_DM_DAILY_CAP: "0" }, () => {
      expect(loadEnv().LINKEDIN_INTRO_DM_DAILY_CAP).toBe(0);
    });
  });

  it("defaults reply verification on while grounded-drafting extras remain off", () => {
    withEnv({}, () => {
      const env = loadEnv();
      // Unset dir lists (raw string env) → parseIncludeDirs yields [] → no
      // scoping / no knowledge pass.
      expect(parseIncludeDirs(env.NOELLE_VOICE_DIRS)).toEqual([]);
      expect(parseIncludeDirs(env.NOELLE_KNOWLEDGE_DIRS)).toEqual([]);
      // Knowledge top-K, verifier, and retries defaults.
      expect(env.NOELLE_DRAFTER_KNOWLEDGE_TOPK).toBe(4);
      expect(env.NOELLE_DRAFTER_VERIFY).toBe(true);
      expect(env.NOELLE_DRAFTER_VERIFY_RETRIES).toBe(3);
    });
  });

  it("parses the grounded-drafting flags when the operator opts in", () => {
    withEnv(
      {
        NOELLE_VOICE_DIRS: " 02-brand , 03-voice ",
        NOELLE_KNOWLEDGE_DIRS: "01-business,04-icp",
        NOELLE_DRAFTER_KNOWLEDGE_TOPK: "6",
        NOELLE_DRAFTER_VERIFY: "true",
        NOELLE_DRAFTER_VERIFY_RETRIES: "1",
      },
      () => {
        const env = loadEnv();
        // parseIncludeDirs trims + drops empties (same parsing as NOELLE_VOICE_DIRS).
        expect(parseIncludeDirs(env.NOELLE_VOICE_DIRS)).toEqual(["02-brand", "03-voice"]);
        expect(parseIncludeDirs(env.NOELLE_KNOWLEDGE_DIRS)).toEqual(["01-business", "04-icp"]);
        expect(env.NOELLE_DRAFTER_KNOWLEDGE_TOPK).toBe(6);
        expect(env.NOELLE_DRAFTER_VERIFY).toBe(true);
        expect(env.NOELLE_DRAFTER_VERIFY_RETRIES).toBe(1);
      },
    );
  });

  it("boolFlag: 'false' / '0' do NOT enable the verifier (Boolean('false') trap)", () => {
    for (const v of ["false", "0", "", "no"]) {
      withEnv({ NOELLE_DRAFTER_VERIFY: v }, () => {
        expect(loadEnv().NOELLE_DRAFTER_VERIFY).toBe(false);
      });
    }
    withEnv({ NOELLE_DRAFTER_VERIFY: "1" }, () => {
      expect(loadEnv().NOELLE_DRAFTER_VERIFY).toBe(true);
    });
  });

  it("defaults NOELLE_DRAFTER_VARIETY OFF and respects the boolFlag trap", () => {
    withEnv({}, () => {
      expect(loadEnv().NOELLE_DRAFTER_VARIETY).toBe(false);
    });
    for (const v of ["false", "0", "", "no"]) {
      withEnv({ NOELLE_DRAFTER_VARIETY: v }, () => {
        expect(loadEnv().NOELLE_DRAFTER_VARIETY).toBe(false);
      });
    }
    for (const v of ["1", "true", "TRUE"]) {
      withEnv({ NOELLE_DRAFTER_VARIETY: v }, () => {
        expect(loadEnv().NOELLE_DRAFTER_VARIETY).toBe(true);

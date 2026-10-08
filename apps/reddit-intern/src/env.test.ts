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

describe("loadEnv (reddit-intern)", () => {
  afterEach(() => resetEnvForTests());

  it("applies the Reddit-specific defaults", () => {
    withEnv({}, () => {
      const env = loadEnv();
      expect(env.REDDIT_DISCOVERY_LIMIT).toBe(15);
      expect(env.REDDIT_OPUS_SCORE).toBe(500);
      expect(env.REDDIT_OPUS_COMMENTS).toBe(100);
      expect(env.REDDIT_GOAL_STALL_MIN).toBe(120);
    });
  });

  it("coerces overrides for the Reddit knobs", () => {
    withEnv(
      { REDDIT_DISCOVERY_LIMIT: "8", REDDIT_OPUS_SCORE: "1000", REDDIT_OPUS_COMMENTS: "50" },
      () => {
        const env = loadEnv();
        expect(env.REDDIT_DISCOVERY_LIMIT).toBe(8);
        expect(env.REDDIT_OPUS_SCORE).toBe(1000);
        expect(env.REDDIT_OPUS_COMMENTS).toBe(50);
      },
    );
  });

  it("knows the three pipeline worker kinds (discovery/classifier/drafter) but NOT send", () => {
    for (const kind of ["discovery", "classifier", "drafter"]) {
      withEnv({ NOELLE_WORKER_KIND: kind }, () => {
        expect(loadEnv().NOELLE_WORKER_KIND).toBe(kind);
      });
    }
    // Orion never posts to Reddit — there is no send worker.
    withEnv({ NOELLE_WORKER_KIND: "send" }, () => {
      expect(() => loadEnv()).toThrow();
    });
    // The dropped lanes (profiler / ideation / feeder) are no longer worker kinds.
    for (const kind of ["profiler", "ideation", "feeder", "post-drafter"]) {
      withEnv({ NOELLE_WORKER_KIND: kind }, () => {
        expect(() => loadEnv()).toThrow();
      });
    }
  });

  it("applies the quality-pipeline defaults", () => {
    withEnv({}, () => {
      const env = loadEnv();
      expect(env.REDDIT_Q_THRESHOLD).toBe(75);
      expect(env.REDDIT_DAILY_EXTRACT_CAP).toBe(80);
      // 0 = unlimited on both draft buckets. Orion is draft-only, so a daily
      // bucket protects nothing and only starves the approval queue.
      expect(env.REDDIT_DAILY_SUBSTANTIAL_CAP).toBe(0);
      expect(env.REDDIT_DAILY_LIGHT_CAP).toBe(0);
      expect(env.CLASSIFIER_POLL_MS).toBe(30_000);
      expect(env.CLASSIFIER_BATCH).toBe(10);
    });
  });

  it("coerces overrides for the quality-pipeline knobs", () => {
    withEnv(
      {
        REDDIT_Q_THRESHOLD: "80",
        REDDIT_DAILY_EXTRACT_CAP: "120",
        REDDIT_DAILY_SUBSTANTIAL_CAP: "40",
        REDDIT_DAILY_LIGHT_CAP: "10",
        CLASSIFIER_BATCH: "5",
      },
      () => {
        const env = loadEnv();
        expect(env.REDDIT_Q_THRESHOLD).toBe(80);
        expect(env.REDDIT_DAILY_EXTRACT_CAP).toBe(120);
        expect(env.REDDIT_DAILY_SUBSTANTIAL_CAP).toBe(40);
        expect(env.REDDIT_DAILY_LIGHT_CAP).toBe(10);
        expect(env.CLASSIFIER_BATCH).toBe(5);
      },
    );
  });

  it("defaults the watchlist re-poll cooldown OFF (0 hours = every-tick behaviour)", () => {
    withEnv({}, () => {
      expect(loadEnv().REDDIT_WATCHLIST_REPOLL_HOURS).toBe(0);
    });
  });

  it("coerces the re-poll cooldown (fractional hours allowed, negatives rejected)", () => {
    withEnv({ REDDIT_WATCHLIST_REPOLL_HOURS: "1.5" }, () => {
      expect(loadEnv().REDDIT_WATCHLIST_REPOLL_HOURS).toBe(1.5);
    });
    withEnv({ REDDIT_WATCHLIST_REPOLL_HOURS: "-1" }, () => {
      expect(() => loadEnv()).toThrow();
    });
  });

  it("defaults the Pattern Breaker OFF with the shared knob defaults", () => {
    withEnv({}, () => {
      const env = loadEnv();
      expect(env.REDDIT_PATTERN_BREAKER).toBe(false);
      expect(env.PATTERN_BREAKER_INTERVAL_MS).toBe(6 * 60 * 60_000);
      expect(env.PATTERN_BREAKER_MIN_FREQUENCY).toBe(3);
      expect(env.PATTERN_BREAKER_MIN_RATIO).toBe(0.3);
      expect(env.PATTERN_BREAKER_MAX_POSTS).toBe(100);
    });
    // boolFlag trap: "false"/"0" must not enable it.
    for (const v of ["false", "0", "", "no"]) {
      withEnv({ REDDIT_PATTERN_BREAKER: v }, () => {
        expect(loadEnv().REDDIT_PATTERN_BREAKER).toBe(false);
      });
    }
    withEnv({ REDDIT_PATTERN_BREAKER: "1" }, () => {
      expect(loadEnv().REDDIT_PATTERN_BREAKER).toBe(true);
    });
  });

  it("defaults the grounded-drafting flags to OFF (live behavior unchanged)", () => {
    withEnv({}, () => {
      const env = loadEnv();
      expect(parseIncludeDirs(env.NOELLE_VOICE_DIRS)).toEqual([]);
      expect(parseIncludeDirs(env.NOELLE_KNOWLEDGE_DIRS)).toEqual([]);
      expect(env.NOELLE_DRAFTER_KNOWLEDGE_TOPK).toBe(4);
      expect(env.NOELLE_DRAFTER_VERIFY).toBe(false);
      expect(env.NOELLE_DRAFTER_VERIFY_RETRIES).toBe(2);
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
      });
    }
  });
});


it("keeps local retrieval free of implicit remote workspace defaults", () => {
  const original = process.env;
  try {
    process.env = { NOELLE_DATABASE_URL: "postgres://localhost/noelle", NOELLE_HMAC_SECRET: "x".repeat(32), NOELLE_NELLA_BACKEND: "local", NOELLE_VAULT_DIR: "/voice-vault" };
    resetEnvForTests();
    expect(loadEnv().NELLA_WORKSPACE).toBe("");
    process.env.NELLA_WORKSPACE = " configured-workspace ";
    resetEnvForTests();
    expect(loadEnv().NELLA_WORKSPACE).toBe("configured-workspace");
  } finally {
    process.env = original;
    resetEnvForTests();
  }
});

import { afterEach, describe, expect, it } from "vitest";
import { loadEnv, resetEnvForTests } from "./env.js";

describe("loadEnv", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
    resetEnvForTests();
  });

  it("parses required env for discovery worker", () => {
    process.env.NOELLE_WORKER_KIND = "discovery";
    process.env.NOELLE_DATABASE_URL = "postgres://x:y@127.0.0.1:5432/postgres";
    process.env.NOELLE_HMAC_SECRET = "x".repeat(32);
    process.env.CP_BASE_URL = "https://api.trynoelle.com";
    process.env.GCP_PROJECT = "noelle-agents";
    process.env.WORKER_ID = "0";
    const env = loadEnv();
    expect(env.NOELLE_DATABASE_URL).toMatch(/postgres:\/\//);
    expect(env.WORKER_ID).toBe("0");
    expect(env.GCP_PROJECT).toBe("noelle-agents");
  });

  it("throws when NOELLE_DATABASE_URL is missing", () => {
    delete process.env.NOELLE_DATABASE_URL;
    expect(() => loadEnv()).toThrow();
  });

  it("defaults to LinkedIn's voice floor and accepts an explicit override", () => {
    process.env.NOELLE_DATABASE_URL = "postgres://x:y@127.0.0.1:5432/postgres";
    process.env.NOELLE_HMAC_SECRET = "x".repeat(32);
    delete process.env.NOELLE_DRAFTER_VOICE_FLOOR;
    expect(loadEnv().NOELLE_DRAFTER_VOICE_FLOOR).toBe(0.65);
    resetEnvForTests();
    process.env.NOELLE_DRAFTER_VOICE_FLOOR = "0";
    expect(loadEnv().NOELLE_DRAFTER_VOICE_FLOOR).toBe(0);
  });

  it("reviews new X replies by default and respects an explicit verifier disable", () => {
    process.env.NOELLE_DATABASE_URL = "postgres://x:y@127.0.0.1:5432/postgres";
    process.env.NOELLE_HMAC_SECRET = "x".repeat(32);
    delete process.env.NOELLE_DRAFTER_VERIFY;
    expect(loadEnv().NOELLE_DRAFTER_VERIFY).toBe(true);
    resetEnvForTests();
    process.env.NOELLE_DRAFTER_VERIFY = "false";
    expect(loadEnv().NOELLE_DRAFTER_VERIFY).toBe(false);
  });

  it("uses all three bounded repair attempts by default", () => {
    process.env.NOELLE_DATABASE_URL = "postgres://x:y@127.0.0.1:5432/postgres";
    process.env.NOELLE_HMAC_SECRET = "x".repeat(32);
    delete process.env.NOELLE_DRAFTER_VERIFY_RETRIES;
    expect(loadEnv().NOELLE_DRAFTER_VERIFY_RETRIES).toBe(3);
  });
  it.each(["", " ", "\t"])("keeps the age ceiling for blank configuration %j", raw => {
    process.env.NOELLE_DATABASE_URL = "postgres://x:y@127.0.0.1:5432/postgres";
    process.env.NOELLE_HMAC_SECRET = "x".repeat(32);
    process.env.X_REPLY_MAX_AGE_HOURS = raw;
    expect(loadEnv().X_REPLY_MAX_AGE_HOURS).toBe(25);
  });
  it("preserves explicit zero expiry and rejects fractional hours at boot", () => {
    process.env.NOELLE_DATABASE_URL = "postgres://x:y@127.0.0.1:5432/postgres";
    process.env.NOELLE_HMAC_SECRET = "x".repeat(32);
    process.env.X_REPLY_MAX_AGE_HOURS = "0";
    expect(loadEnv().X_REPLY_MAX_AGE_HOURS).toBe(0);
    resetEnvForTests(); process.env.X_REPLY_MAX_AGE_HOURS = "1.5";
    expect(() => loadEnv()).toThrow();
  });

  it("defaults Apify reply-lead sourcing off after the browser canary", () => {
    process.env.NOELLE_DATABASE_URL = "postgres://x:y@127.0.0.1:5432/postgres";
    process.env.NOELLE_HMAC_SECRET = "x".repeat(32);
    delete process.env.X_APIFY_REPLY_LEADS;
    expect(loadEnv().X_APIFY_REPLY_LEADS).toBe(false);
    resetEnvForTests();
    process.env.X_APIFY_REPLY_LEADS = "0";
    expect(loadEnv().X_APIFY_REPLY_LEADS).toBe(false);
  });

  it("defaults NOELLE_DRAFTER_VARIETY OFF and respects the boolFlag trap", () => {
    process.env.NOELLE_DATABASE_URL = "postgres://x:y@127.0.0.1:5432/postgres";
    process.env.NOELLE_HMAC_SECRET = "x".repeat(32);
    // Unset → off.
    delete process.env.NOELLE_DRAFTER_VARIETY;
    expect(loadEnv().NOELLE_DRAFTER_VARIETY).toBe(false);
    // 'false' / '0' must NOT enable it (Boolean('false') trap).
    for (const v of ["false", "0", "", "no"]) {
      resetEnvForTests();
      process.env.NOELLE_DRAFTER_VARIETY = v;
      expect(loadEnv().NOELLE_DRAFTER_VARIETY).toBe(false);
    }
    for (const v of ["1", "true", "TRUE"]) {
      resetEnvForTests();
      process.env.NOELLE_DRAFTER_VARIETY = v;
      expect(loadEnv().NOELLE_DRAFTER_VARIETY).toBe(true);
    }
  });

  it("exposes the self-host Gemini key used by the classifier", () => {
    process.env.NOELLE_DATABASE_URL = "postgres://x:y@127.0.0.1:5432/postgres";
    process.env.NOELLE_HMAC_SECRET = "x".repeat(32);
    process.env.NOELLE_GEMINI_API_KEY = "AIza-test";

    expect(loadEnv().NOELLE_GEMINI_API_KEY).toBe("AIza-test");
  });

  // run.sh exports NOELLE_WORKER_KIND=<kind> for every worker unit, so the enum
  // MUST include every kind run.sh can be invoked with — a missing one (e.g.
  // "profiler") makes loadEnv() throw at boot and the unit crash-loops.
  it.each(["discovery", "classifier", "drafter", "send", "profiler"])(
    "accepts NOELLE_WORKER_KIND=%s",
    (kind) => {
      process.env.NOELLE_WORKER_KIND = kind;
      process.env.NOELLE_DATABASE_URL = "postgres://x:y@127.0.0.1:5432/postgres";
      process.env.NOELLE_HMAC_SECRET = "x".repeat(32);
      expect(() => loadEnv()).not.toThrow();
    },
  );
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

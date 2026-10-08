import { describe, expect, it, vi } from "vitest";
import { createApifyResolver, handleTokenFatal, createApifyPoolResolver } from "./apify-resolver.js";
import { AllApifyTokensExhaustedError } from "./apify-rotating.js";

// Mock the account probe + the DB flag writers, but keep listApifyTokens REAL so the
// createApifyResolver tests below still exercise it against the fake sql queue.
vi.mock("@noelle/reddit-apify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@noelle/reddit-apify")>();
  return { ...actual, checkApifyToken: vi.fn() };
});
vi.mock("./connections-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./connections-db.js")>();
  return {
    ...actual,
    markApifyTokenInvalid: vi.fn().mockResolvedValue(true),
    markApifyTokenExhausted: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./apify-rotating.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./apify-rotating.js")>();
  return { ...actual, createRotatingApifyClient: vi.fn(actual.createRotatingApifyClient) };
});

const log = { warn: vi.fn() };

type Row = { id: string; secret: string; exhausted: boolean; available: boolean };
function tok(id: string, secret: string, available = true): Row {
  return { id, secret, exhausted: !available, available };
}

// Fake tagged-template sql that returns whatever the queue yields for the next call.
function makeSql(queue: Row[][]) {
  let i = 0;
  return ((..._a: unknown[]) => Promise.resolve(queue[i++] ?? [])) as never;
}

describe("createApifyResolver", () => {
  it("prefers the active DB connection (token + credentialId from the row)", async () => {
    const resolve = createApifyResolver({
      sql: makeSql([[tok("cred-1", "tok_db")]]),
      secrets: { get: vi.fn().mockRejectedValue(new Error("should not be called")) },
      apifyTokenSecretId: "apify-token",
      log,
    });
    const h = await resolve("org-1");
    expect(h?.credentialId).toBe("cred-1");
    expect(h?.client).toBeTruthy();
  });

  it("falls back to env/SM when no DB tokens (credentialId null)", async () => {
    const resolve = createApifyResolver({
      sql: makeSql([[]]), // no DB rows
      secrets: { get: vi.fn().mockResolvedValue("tok_env") },
      apifyTokenSecretId: "apify-token",
      log,
    });
    const h = await resolve("org-1");
    expect(h?.credentialId).toBeNull();
    expect(h?.client).toBeTruthy();
  });

  it("returns null (caller skips) when no token anywhere", async () => {
    const resolve = createApifyResolver({
      sql: makeSql([[]]),
      secrets: { get: vi.fn().mockRejectedValue(new Error("not set")) },
      apifyTokenSecretId: "apify-token",
      log,
    });
    expect(await resolve("org-1")).toBeNull();
  });

  it("stamps the primary AVAILABLE token's credentialId, and reflects it each call", async () => {
    const resolve = createApifyResolver({
      sql: makeSql([
        [tok("cred-1", "tok_a"), tok("cred-2", "tok_b")],
        [tok("cred-2", "tok_b")],
      ]),
      secrets: { get: vi.fn() },
      apifyTokenSecretId: "apify-token",
      log,
    });
    const a = await resolve("org-1");
    const b = await resolve("org-1");
    expect(a!.credentialId).toBe("cred-1"); // primary of the two-token pool
    expect(b!.credentialId).toBe("cred-2"); // pool head after the first was removed
  });

  it("when DB tokens exist but all are cooling, surfaces all-exhausted (no env fallback, no wasted calls)", async () => {
    const secrets = { get: vi.fn() };
    const resolve = createApifyResolver({
      sql: makeSql([[tok("cred-1", "tok_a", false), tok("cred-2", "tok_b", false)]]),
      secrets,
      apifyTokenSecretId: "apify-token",
      log,
    });
    const h = await resolve("org-1");
    // A handle is returned (not null) so the worker records the error + pings the
    // operator, but no token is available so the first call raises all-exhausted.
    expect(h).not.toBeNull();
    expect(h!.credentialId).toBeNull();
    expect(secrets.get).not.toHaveBeenCalled(); // a DB pool exists → env never used
    await expect(h!.client.subredditPosts({ subreddit: "x" })).rejects.toBeInstanceOf(
      AllApifyTokensExhaustedError,
    );
    await expect(h!.client.subredditPosts({ subreddit: "x" })).rejects.toMatchObject({ tokenCount: 2 });
  });
});

describe("handleTokenFatal — verify before invalidating (parity with the LinkedIn intern)", () => {
  const depsFor = () => ({
    sql: (() => Promise.resolve([])) as never,
    secrets: { get: vi.fn() },
    apifyTokenSecretId: "apify-token",
    log: { warn: vi.fn() },
  });

  it("401 + health-check ALIVE => NOT invalid, short cooldown (no single-401 kill)", async () => {
    const { checkApifyToken } = await import("@noelle/reddit-apify");
    const db = await import("./connections-db.js");
    vi.mocked(checkApifyToken).mockReset();
    vi.mocked(db.markApifyTokenInvalid).mockClear();
    vi.mocked(db.markApifyTokenExhausted).mockClear();
    vi.mocked(checkApifyToken).mockResolvedValue({ alive: true, httpStatus: 200, remainingUsd: 4 });

    await handleTokenFatal(depsFor(), "cred-1", 401, "tok_live", "org-1");

    expect(checkApifyToken).toHaveBeenCalledWith("tok_live");
    expect(db.markApifyTokenInvalid).not.toHaveBeenCalled();
    expect(db.markApifyTokenExhausted).toHaveBeenCalledWith(expect.anything(), "cred-1", { cooldownDays: 1 });
  });

  it("401 + health-check DEAD (httpStatus 401) => marked invalid", async () => {
    const { checkApifyToken } = await import("@noelle/reddit-apify");
    const db = await import("./connections-db.js");
    vi.mocked(checkApifyToken).mockReset();
    vi.mocked(db.markApifyTokenInvalid).mockClear();
    vi.mocked(db.markApifyTokenExhausted).mockClear();
    vi.mocked(checkApifyToken).mockResolvedValue({ alive: false, httpStatus: 401, error: "token-not-found" });

    await handleTokenFatal(depsFor(), "cred-2", 401, "tok_dead", "org-1");

    expect(db.markApifyTokenInvalid).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-1", credentialId: "cred-2", token: "tok_dead",
    });
    expect(db.markApifyTokenExhausted).not.toHaveBeenCalled();
  });

  it("403 (monthly cap) + probe reports a cycle => exhausted, retry aligned to the REAL reset", async () => {
    const { checkApifyToken } = await import("@noelle/reddit-apify");
    const db = await import("./connections-db.js");
    vi.mocked(checkApifyToken).mockReset();
    vi.mocked(db.markApifyTokenInvalid).mockClear();
    vi.mocked(db.markApifyTokenExhausted).mockClear();
    vi.mocked(checkApifyToken).mockResolvedValue({
      alive: true,
      httpStatus: 200,
      cycleEndAt: "2026-07-19T23:59:59.999Z",
    });

    await handleTokenFatal(depsFor(), "cred-4", 403, "tok_capped", "org-1");

    expect(checkApifyToken).toHaveBeenCalledWith("tok_capped");
    expect(db.markApifyTokenInvalid).not.toHaveBeenCalled();
    const call = vi.mocked(db.markApifyTokenExhausted).mock.calls[0]!;
    expect(call[1]).toBe("cred-4");
    const expected = Date.parse("2026-07-19T23:59:59.999Z") + 60 * 60 * 1000;
    expect((call[2] as { retryAt: Date }).retryAt.getTime()).toBe(expected);
  });

  it("403 but the probe can't report a cycle => exhausted with the default cooldown", async () => {
    const { checkApifyToken } = await import("@noelle/reddit-apify");
    const db = await import("./connections-db.js");
    vi.mocked(checkApifyToken).mockReset();
    vi.mocked(db.markApifyTokenExhausted).mockClear();
    vi.mocked(checkApifyToken).mockResolvedValue({ alive: true, httpStatus: 200 });

    await handleTokenFatal(depsFor(), "cred-4b", 403, "tok_capped2", "org-1");

    expect(db.markApifyTokenExhausted).toHaveBeenCalledWith(expect.anything(), "cred-4b", {});
  });

  it("402 (payment) => exhausted, NO health-check, default cooldown", async () => {
    const { checkApifyToken } = await import("@noelle/reddit-apify");
    const db = await import("./connections-db.js");
    vi.mocked(checkApifyToken).mockReset();
    vi.mocked(db.markApifyTokenInvalid).mockClear();
    vi.mocked(db.markApifyTokenExhausted).mockClear();

    await handleTokenFatal(depsFor(), "cred-5", 402, "tok_pay", "org-1");

    expect(checkApifyToken).not.toHaveBeenCalled();
    expect(db.markApifyTokenInvalid).not.toHaveBeenCalled();
    expect(db.markApifyTokenExhausted).toHaveBeenCalledWith(expect.anything(), "cred-5");
  });
});


describe("resolved reactive credential scope", () => {
  it("binds the actual resolver organization and captured stored key to its fatal callback", async () => {
    const db = await import("./connections-db.js");
    const { checkApifyToken } = await import("@noelle/reddit-apify");
    const rotation = await import("./apify-rotating.js");
    vi.mocked(checkApifyToken).mockResolvedValue({ alive: false, httpStatus: 401 });
    vi.mocked(db.markApifyTokenInvalid).mockClear();
    vi.mocked(rotation.createRotatingApifyClient).mockClear();
    const resolve = createApifyPoolResolver({
      sql: makeSql([[tok("captured-id", " captured-key ")]]),
      secrets: { get: vi.fn() }, apifyTokenSecretId: "fixture", log,
    });
    await resolve("actual-org");
    const callback = vi.mocked(rotation.createRotatingApifyClient).mock.calls[0]?.[0].onTokenFatal;
    expect(callback).toBeTypeOf("function");
    callback!("captured-id", 401, " captured-key ");
    await vi.waitFor(() => expect(db.markApifyTokenInvalid).toHaveBeenCalledWith(expect.anything(), {
      orgId: "actual-org", credentialId: "captured-id", token: " captured-key ",
    }));
  });
});

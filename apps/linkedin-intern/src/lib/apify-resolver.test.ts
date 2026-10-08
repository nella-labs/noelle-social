import { describe, expect, it, vi } from "vitest";
import { createApifyResolver, handleTokenFatal, createApifyPoolResolver } from "./apify-resolver.js";
import { AllApifyTokensExhaustedError } from "./apify-rotating.js";

vi.mock("./apify-rotating.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./apify-rotating.js")>();
  return { ...actual, createRotatingApifyClient: vi.fn(actual.createRotatingApifyClient) };
});

const log = { warn: vi.fn() };

vi.mock("@noelle/runtime/apify-pool-db", async importOriginal => {
  const actual = await importOriginal<typeof import("@noelle/runtime/apify-pool-db")>();
  return { ...actual, withApifyCredentialDb: async (sql: never, operation: (sql: never) => Promise<unknown>) => operation(sql) };
});

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
  it.each(["single", "pool"] as const)("rejects a failed %s pool read before legacy lookup", async kind => {
    const unavailable = new Error("fixture credential read unavailable");
    const secrets = { get: vi.fn(async () => "legacy-fixture-token") };
    const deps = {
      sql: vi.fn(async () => { throw unavailable; }) as never,
      secrets, apifyTokenSecretId: "fixture", log,
    };
    const resolve = kind === "single" ? createApifyResolver(deps) : createApifyPoolResolver(deps);
    await expect(resolve("org-1")).rejects.toBe(unavailable);
    expect(secrets.get).not.toHaveBeenCalled();
  });
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
    await expect(h!.client.profilePosts({ publicId: "x" })).rejects.toBeInstanceOf(
      AllApifyTokensExhaustedError,
    );
    await expect(h!.client.searchPosts({ queries: ["x"] })).rejects.toMatchObject({ tokenCount: 2 });
  });
});


// --- Verify-before-invalidate (the single-401 kill bug) -----------------------
// A 401 from one actor call used to permanently mark a token invalid. Now the
// resolver health-checks the token FIRST: invalid only if the health-check ALSO
// reports dead (httpStatus 401). A transient 401 (token still alive) just gets a
// short cooldown so it re-enters rotation, instead of being killed forever.

vi.mock("@noelle/linkedin-apify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@noelle/linkedin-apify")>();
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

describe("handleTokenFatal — verify before invalidating", () => {
  const depsFor = () => ({
    sql: (() => Promise.resolve([])) as never,
    secrets: { get: vi.fn() },
    apifyTokenSecretId: "apify-token",
    log: { warn: vi.fn() },
  });

  it("401 + health-check ALIVE => NOT invalid, short cooldown (no single-401 kill)", async () => {
    const { checkApifyToken } = await import("@noelle/linkedin-apify");
    const db = await import("./connections-db.js");
    vi.mocked(checkApifyToken).mockReset();
    vi.mocked(db.markApifyTokenInvalid).mockClear();
    vi.mocked(db.markApifyTokenExhausted).mockClear();
    vi.mocked(checkApifyToken).mockResolvedValue({ alive: true, httpStatus: 200, remainingUsd: 4 });

    await handleTokenFatal(depsFor(), "cred-1", 401, "tok_live", "org-1");

    expect(checkApifyToken).toHaveBeenCalledWith("tok_live");
    expect(db.markApifyTokenInvalid).not.toHaveBeenCalled();
    // Gets a SHORT cooldown (1 day) rather than a permanent kill.
    expect(db.markApifyTokenExhausted).toHaveBeenCalledWith(expect.anything(), "cred-1", { cooldownDays: 1 });
  });

  it("401 + health-check DEAD (httpStatus 401) => marked invalid", async () => {
    const { checkApifyToken } = await import("@noelle/linkedin-apify");
    const db = await import("./connections-db.js");
    vi.mocked(checkApifyToken).mockReset();
    vi.mocked(db.markApifyTokenInvalid).mockClear();
    vi.mocked(db.markApifyTokenExhausted).mockClear();
    vi.mocked(checkApifyToken).mockResolvedValue({ alive: false, httpStatus: 401, error: "token-not-found" });

    await handleTokenFatal(depsFor(), "cred-2", 401, "tok_dead", "org-1");

    expect(checkApifyToken).toHaveBeenCalledWith("tok_dead");
    expect(db.markApifyTokenInvalid).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-1", credentialId: "cred-2", token: "tok_dead",
    });
    expect(db.markApifyTokenExhausted).not.toHaveBeenCalled();
  });

  it("401 + health-check INCONCLUSIVE (network err, httpStatus 0) => cooldown, never killed", async () => {
    const { checkApifyToken } = await import("@noelle/linkedin-apify");
    const db = await import("./connections-db.js");
    vi.mocked(checkApifyToken).mockReset();
    vi.mocked(db.markApifyTokenInvalid).mockClear();
    vi.mocked(db.markApifyTokenExhausted).mockClear();
    vi.mocked(checkApifyToken).mockResolvedValue({ alive: false, httpStatus: 0, error: "ENOTFOUND" });

    await handleTokenFatal(depsFor(), "cred-3", 401, "tok_x", "org-1");

    expect(db.markApifyTokenInvalid).not.toHaveBeenCalled();
    expect(db.markApifyTokenExhausted).toHaveBeenCalledWith(expect.anything(), "cred-3", { cooldownDays: 1 });
  });

  it("403 (monthly cap) + probe reports a cycle => exhausted, retry aligned to the REAL reset", async () => {
    const { checkApifyToken } = await import("@noelle/linkedin-apify");
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

    // 403 now probes the account's real billing cycle (free, no spend).
    expect(checkApifyToken).toHaveBeenCalledWith("tok_capped");
    expect(db.markApifyTokenInvalid).not.toHaveBeenCalled();
    const call = vi.mocked(db.markApifyTokenExhausted).mock.calls[0]!;
    expect(call[1]).toBe("cred-4");
    // retry_at = cycle end + 1h buffer, NOT a flat +30d.
    const expected = Date.parse("2026-07-19T23:59:59.999Z") + 60 * 60 * 1000;
    expect((call[2] as { retryAt: Date }).retryAt.getTime()).toBe(expected);
  });

  it("403 but the probe can't report a cycle => exhausted with the default cooldown", async () => {
    const { checkApifyToken } = await import("@noelle/linkedin-apify");
    const db = await import("./connections-db.js");
    vi.mocked(checkApifyToken).mockReset();
    vi.mocked(db.markApifyTokenExhausted).mockClear();
    vi.mocked(checkApifyToken).mockResolvedValue({ alive: true, httpStatus: 200 });

    await handleTokenFatal(depsFor(), "cred-4b", 403, "tok_capped2", "org-1");

    // No cycleEndAt → fall back to the default (empty opts → 30d in the DB layer).
    expect(db.markApifyTokenExhausted).toHaveBeenCalledWith(expect.anything(), "cred-4b", {});
  });

  it("402 (payment) => exhausted, NO health-check, default cooldown", async () => {
    const { checkApifyToken } = await import("@noelle/linkedin-apify");
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
    const { checkApifyToken } = await import("@noelle/linkedin-apify");
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

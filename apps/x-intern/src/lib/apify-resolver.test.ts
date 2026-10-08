import { describe, expect, it, vi } from "vitest";
import { createApifyResolver, handleTokenFatal } from "./apify-resolver.js";

// Mock the account probe + the DB flag writers, but keep listApifyTokens REAL so the
// createApifyResolver tests below still exercise it against the fake sql queue.
vi.mock("@noelle/x-apify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@noelle/x-apify")>();
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

type Row = { id: string; secret: string; exhausted: boolean; invalid: boolean; available: boolean };
function tok(id: string, secret: string, available = true): Row {
  return { id, secret, exhausted: !available, invalid: false, available };
}
function makeSql(queue: Row[][]) {
  let i = 0;
  return ((..._a: unknown[]) => Promise.resolve(queue[i++] ?? [])) as never;
}

describe("createApifyResolver (X reads off the shared apify pool)", () => {
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
      sql: makeSql([[]]),
      secrets: { get: vi.fn().mockResolvedValue("tok_env") },
      apifyTokenSecretId: "apify-token",
      log,
    });
    const h = await resolve("org-1");
    expect(h?.credentialId).toBeNull();
  });
});

describe("handleTokenFatal — verify before invalidating (parity with Lyra + Orion)", () => {
  const depsFor = () => ({
    sql: (() => Promise.resolve([])) as never,
    secrets: { get: vi.fn() },
    apifyTokenSecretId: "apify-token",
    log: { warn: vi.fn() },
  });

  it("401 + health-check ALIVE => NOT invalid, short cooldown (no single-401 kill)", async () => {
    const { checkApifyToken } = await import("@noelle/x-apify");
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
    const { checkApifyToken } = await import("@noelle/x-apify");
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
    const { checkApifyToken } = await import("@noelle/x-apify");
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
    const { checkApifyToken } = await import("@noelle/x-apify");
    const db = await import("./connections-db.js");
    vi.mocked(checkApifyToken).mockReset();
    vi.mocked(db.markApifyTokenExhausted).mockClear();
    vi.mocked(checkApifyToken).mockResolvedValue({ alive: true, httpStatus: 200 });

    await handleTokenFatal(depsFor(), "cred-4b", 403, "tok_capped2", "org-1");

    expect(db.markApifyTokenExhausted).toHaveBeenCalledWith(expect.anything(), "cred-4b", {});
  });

  it("402 (payment) => exhausted, NO health-check, default cooldown", async () => {
    const { checkApifyToken } = await import("@noelle/x-apify");
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
    const { checkApifyToken } = await import("@noelle/x-apify");
    const rotation = await import("./apify-rotating.js");
    vi.mocked(checkApifyToken).mockResolvedValue({ alive: false, httpStatus: 401 });
    vi.mocked(db.markApifyTokenInvalid).mockClear();
    vi.mocked(rotation.createRotatingApifyClient).mockClear();
    const resolve = createApifyResolver({
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

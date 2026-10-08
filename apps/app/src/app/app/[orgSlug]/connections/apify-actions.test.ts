import http from "node:http";
import https from "node:https";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  health: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
  revalidate: vi.fn(),
  member: true,
  invalid: false,
}));
vi.mock("@/lib/db", () => ({ sql: {} }));
vi.mock("next/cache", () => ({ revalidatePath: f.revalidate }));
vi.mock("@/lib/queries", () => ({
  getCurrentUser: async () => (f.member ? { id: "33333333-3333-4333-8333-333333333333" } : null),
  getOrgBySlug: async () => ({ id: "22222222-2222-4222-8222-222222222222", slug: "operator" }),
  listApifyConnectionSecrets: async () => [
    {
      id: "11111111-1111-4111-8111-111111111111",
      label: "masked",
      secret: "private-token",
      invalid: f.invalid,
    },
  ],
  clearApifyConnectionInvalid: f.clear,
}));
vi.mock("@noelle/runtime/apify-usage", () => ({ checkApifyAccountUsage: f.health }));
vi.mock("@noelle/runtime/apify-usage-db", () => ({ saveApifyUsage: f.save }));
vi.mock("@/lib/connections", () => ({}));
import { testApifyToken, testAllApifyTokens } from "./actions";
const input = { orgSlug: "operator", credentialId: "11111111-1111-4111-8111-111111111111" };
beforeEach(() => {
  vi.clearAllMocks();
  f.member = true;
  f.invalid = false;
  f.health.mockResolvedValue({ alive: true, httpStatus: 200, monthlyUsageUsd: 2.51 });
  f.save.mockResolvedValue({ saved: true, reason: "inserted" });
  f.clear.mockResolvedValue(undefined);
  vi.spyOn(http, "request").mockImplementation(() => {
    throw new Error("HTTP forbidden");
  });
  vi.spyOn(https, "request").mockImplementation(() => {
    throw new Error("HTTPS forbidden");
  });
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("Socket forbidden");
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Fetch forbidden");
    }),
  );
});
afterEach(() => {
  expect(http.request).not.toHaveBeenCalled();
  expect(https.request).not.toHaveBeenCalled();
  expect(Socket.prototype.connect).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Apify usage refresh", () => {
  it("saves a successful reading before refreshing the page", async () => {
    expect(await testApifyToken(input)).toMatchObject({
      ok: true,
      result: { monthlyUsageUsd: 2.51 },
    });
    expect(f.save).toHaveBeenCalledWith(
      expect.anything(),
      "22222222-2222-4222-8222-222222222222",
      input.credentialId,
      expect.objectContaining({ monthlyUsageUsd: 2.51 }),
    );
    expect(f.revalidate).toHaveBeenCalledWith("/app/operator/connections");
  });
  it("leaves a saved expense untouched on a later 401", async () => {
    f.health.mockResolvedValue({ alive: false, httpStatus: 401 });
    expect(await testApifyToken(input)).toMatchObject({ ok: true, result: { httpStatus: 401 } });
    expect(f.save).not.toHaveBeenCalled();
  });
  it("does not report a successful usage refresh if saving fails", async () => {
    f.save.mockRejectedValue(new Error("usage storage unavailable"));
    expect(await testApifyToken(input)).toMatchObject({
      ok: false,
      error: { code: "check_failed" },
    });
  });
  it("does not fetch or save for a signed-out caller", async () => {
    f.member = false;
    expect(await testApifyToken(input)).toMatchObject({
      ok: false,
      error: { code: "unauthenticated" },
    });
    expect(f.health).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });
  for (const caller of ["single", "all"] as const) {
    it(`${caller} reports a failed flag clear without claiming revalidation`, async () => {
      f.invalid = true;
      f.clear.mockRejectedValue(new Error("flag storage unavailable"));
      const result =
        caller === "single"
          ? await testApifyToken(input)
          : await testAllApifyTokens({ orgSlug: input.orgSlug });
      expect(result).toMatchObject({ ok: false, error: { code: "check_failed" } });
      expect(f.save).toHaveBeenCalledTimes(1);
      expect(f.revalidate).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("private-token");
    });
  }
  it("confirms flag clearing only after saving provider usage", async () => {
    f.invalid = true;
    const result = await testApifyToken(input);
    expect(result).toMatchObject({ ok: true, result: { alive: true, revalidated: true } });
    expect(f.save.mock.invocationCallOrder[0]).toBeLessThan(f.clear.mock.invocationCallOrder[0]);
    expect(f.clear).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      input.credentialId,
    );
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
  it("keeps an already healthy token unflagged", async () => {
    const result = await testApifyToken(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.revalidated).toBeUndefined();
    expect(f.clear).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  rows: [] as { name: string; value: string }[], set: vi.fn(), request: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => fixture.rows, set: fixture.set }) }));
vi.mock("./api-session-owner", () => ({
  ApiSessionOwner: class { request = fixture.request; },
  ApiSessionError: class extends Error { constructor(readonly code: string) { super(`API session ${code}`); } },
}));
import { getApiSessionAccessToken } from "./api-session";

const name = "sb-fixture-auth-auth-token";
function jwt(expiresIn = 600) {
  return `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresIn })).toString("base64url")}.syntheticSignature`;
}
function store(value: unknown, chunked = false) {
  const raw = `base64-${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
  fixture.rows = chunked ? [{ name: `${name}.1`, value: raw.slice(50) }, { name: `${name}.0`, value: raw.slice(0, 50) }] : [{ name, value: raw }];
}
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture-auth.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon");
  fixture.rows = []; fixture.set.mockReset(); fixture.request.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

it.each([false, true])("forwards a fresh opaque token through the existing cookie decoder (chunked=%s)", async chunked => {
  const token = jwt(); store({ access_token: token, refresh_token: "synthetic-refresh", expires_at: Math.floor(Date.now() / 1000) + 600 }, chunked);
  expect(await getApiSessionAccessToken()).toBe(token);
  expect(fixture.request).not.toHaveBeenCalled(); expect(fixture.set).not.toHaveBeenCalled();
});
it("does not turn a decoded cookie user into an API session", async () => {
  store({ user: { id: "unsigned-user" } }); fixture.request.mockResolvedValue({ accessToken: null, cookies: [] });
  expect(await getApiSessionAccessToken()).toBeNull(); expect(fixture.request).toHaveBeenCalledOnce();
});
it.each([
  { tokenExpiry: 20, cookieExpiry: 600 }, { tokenExpiry: 600, cookieExpiry: 20 },
])("uses the canonical SDK for either token or stored near-expiry %j", async ({ tokenExpiry, cookieExpiry }) => {
  store({ access_token: jwt(tokenExpiry), refresh_token: "synthetic-refresh", expires_at: Math.floor(Date.now() / 1000) + cookieExpiry });
  const token = jwt(); fixture.request.mockResolvedValue({ accessToken: token, cookies: [] });
  expect(await getApiSessionAccessToken(40)).toBe(token);
  expect(fixture.request).toHaveBeenCalledWith(expect.objectContaining({ cookies: fixture.rows, cookieName: name }), 40);
});
it("keeps legacy and malformed session decisions with the SDK", async () => {
  store([jwt()]); fixture.request.mockResolvedValue({ accessToken: null, cookies: [] });
  expect(await getApiSessionAccessToken()).toBeNull();
  fixture.rows = [{ name, value: "not-json" }];
  expect(await getApiSessionAccessToken()).toBeNull(); expect(fixture.request).toHaveBeenCalledTimes(2);
});
it("applies a validated rotated cookie receipt after the owned SDK call returns", async () => {
  store({ access_token: jwt(-10), refresh_token: "synthetic-refresh", expires_at: 1 });
  const token = jwt();
  fixture.request.mockResolvedValue({ accessToken: token, cookies: [{ name, value: "base64-synthetic", options: { path: "/", sameSite: "lax", maxAge: 34_560_000 } }] });
  expect(await getApiSessionAccessToken()).toBe(token);
  expect(fixture.set).toHaveBeenCalledWith(name, "base64-synthetic", { path: "/", sameSite: "lax", maxAge: 34_560_000 });
});
it("preserves canonical cookie clearing for a known rejected refresh", async () => {
  store({ access_token: jwt(-10), refresh_token: "synthetic-refresh", expires_at: 1 });
  fixture.request.mockResolvedValue({ accessToken: null, error: "rejected", cookies: [{ name, value: "", options: { path: "/", maxAge: 0 } }] });
  expect(await getApiSessionAccessToken()).toBeNull(); expect(fixture.set).toHaveBeenCalledOnce();
});
it("never applies cookie writes on an uncertain or unavailable SDK outcome", async () => {
  store({ access_token: jwt(-10), refresh_token: "synthetic-refresh", expires_at: 1 });
  fixture.request.mockResolvedValue({ accessToken: null, error: "unavailable", cookies: [{ name, value: "", options: { maxAge: 0 } }] });
  await expect(getApiSessionAccessToken()).rejects.toMatchObject({ code: "unavailable" }); expect(fixture.set).not.toHaveBeenCalled();
});
it.each([
  { accessToken: "bad\nheader", cookies: [] },
  { accessToken: null, cookies: [{ name: "foreign-cookie", value: "x", options: {} }] },
  { accessToken: null, cookies: [{ name, value: "x", options: { maxAge: Infinity } }] },
  { accessToken: null, cookies: [{ name, value: "x", options: { sameSite: "invalid" } }] },
  { accessToken: null, cookies: [{ name, value: "x", options: {} }, { name, value: "y", options: {} }] },
])("rejects malformed cookie or token receipts before any cookie mutation", async receipt => {
  store({ access_token: jwt(-10), refresh_token: "synthetic-refresh", expires_at: 1 }); fixture.request.mockResolvedValue(receipt);
  await expect(getApiSessionAccessToken()).rejects.toMatchObject({ code: "invalid_response" }); expect(fixture.set).not.toHaveBeenCalled();
});
it("rejects oversized cookie snapshots before admission without changing cookies", async () => {
  fixture.rows = [{ name, value: "x".repeat(32_769) }];
  expect(await getApiSessionAccessToken()).toBeNull(); expect(fixture.request).not.toHaveBeenCalled(); expect(fixture.set).not.toHaveBeenCalled();
});
it("keeps read-only Server Component cookie mutation behavior", async () => {
  store({ access_token: jwt(-10), refresh_token: "synthetic-refresh", expires_at: 1 });
  const token = jwt(); fixture.request.mockResolvedValue({ accessToken: token, cookies: [{ name, value: "x", options: {} }] });
  fixture.set.mockImplementation(() => { throw new Error("synthetic read-only cookie jar"); });
  expect(await getApiSessionAccessToken()).toBe(token);
});

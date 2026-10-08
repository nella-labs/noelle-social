import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  jar: { getAll: () => [] as { name: string; value: string }[] },
  sql: vi.fn(),
  assertMember: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: async () => state.jar }));
vi.mock("react", () => ({ cache: <T>(fn: T) => fn }));
vi.mock("@/lib/db", () => ({ sql: state.sql, readSql: state.sql, pgOrgMembersClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({}) }));
vi.mock("@noelle/runtime", () => ({ assertOrgMember: state.assertMember }));

import { getUserFromCookies } from "./auth-cookie";
import { getOrgBySlug } from "./queries";
import { checkAdmin, checkPrimaryAdmin } from "./admin-gate";
import { GET as firstOrg } from "@/app/api/onboarding/first-org-slug/route";
import { GET as gate } from "@/app/auth/gate/route";

const cookieName = "sb-fixture-auth-auth-token";
const origin = "https://fixture-auth.supabase.co";
const userId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const secret = "fixture-signing-secret-only";
const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = {
  ...key.publicKey.export({ format: "jwk" }),
  kid: "fixture",
  alg: "ES256",
  use: "sig",
};

function token(claims: Record<string, unknown> = {}, algorithm = "ES256") {
  const header = Buffer.from(
    JSON.stringify({ alg: algorithm, typ: "JWT", kid: "fixture" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: userId,
      email: "member@example.com",
      iss: `${origin}/auth/v1`,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 600,
      user_metadata: { full_name: "Member" },
      ...claims,
    }),
  ).toString("base64url");
  const body = `${header}.${payload}`;
  const signature =
    algorithm === "HS256"
      ? createHmac("sha256", secret).update(body).digest()
      : sign("sha256", Buffer.from(body), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  return `${body}.${signature.toString("base64url")}`;
}
function cookie(value: unknown, chunked = false) {
  const raw = `base64-${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
  const rows = chunked
    ? [
        { name: `${cookieName}.1`, value: raw.slice(50) },
        { name: `${cookieName}.0`, value: raw.slice(0, 50) },
      ]
    : [{ name: cookieName, value: raw }];
  state.jar = { getAll: () => rows };
}
function authServer() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/user")) {
      const jwt = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      const [h, p, signature] = jwt.split(".");
      if (
        h &&
        p &&
        signature === createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")
      ) {
        const claims = JSON.parse(Buffer.from(p, "base64url").toString());
        return Response.json({ id: claims.sub, email: claims.email });
      }
      return Response.json({ message: "invalid token" }, { status: 401 });
    }
    throw new Error("unexpected fixture request");
  });
}
beforeEach(() => {
  vi.stubEnv("NOELLE_AUTH_MODE", "supabase");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", origin);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "fixture-anon-key");
  vi.stubEnv("NOELLE_GATE_COOKIE_SECRET", "fixture-gate-secret");
  state.sql
    .mockReset()
    .mockImplementation(async () => [
      { id: "org", slug: "member-org", is_admin: true, email: "member@example.com" },
    ]);
  state.assertMember.mockReset().mockResolvedValue(undefined);
  state.jar = { getAll: () => [] };
  vi.stubGlobal("fetch", authServer());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("verified dashboard cookie identity", () => {
  it("rejects a cookie user object without any verified token before an actual membership read", async () => {
    cookie({ user: { id: userId, email: "unsigned@example.com" } });
    await expect(getOrgBySlug("member-org")).rejects.toThrow("not signed in");
    expect(state.sql).not.toHaveBeenCalled();
    expect(state.assertMember).not.toHaveBeenCalled();
  });
  it("rejects an unsigned decoded subject before an actual membership read", async () => {
    const forged = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: userId })).toString("base64url")}.`;
    cookie({ access_token: forged });
    await expect(getOrgBySlug("member-org")).rejects.toThrow("not signed in");
    expect(state.sql).not.toHaveBeenCalled();
  });
  it("cannot acquire admin or primary-admin status from a supplied cookie email", async () => {
    cookie({ user: { id: userId, email: "unsigned@example.com" } });
    expect(await checkAdmin()).toMatchObject({ isAdmin: false, email: null });
    expect(await checkPrimaryAdmin()).toMatchObject({ isPrimaryAdmin: false, email: null });
    expect(state.sql).not.toHaveBeenCalled();
  });
  it("does not mint a signed gate cookie from a forged invited identity", async () => {
    cookie({ user: { id: userId, email: "member@example.com" } });
    const response = await gate(new NextRequest("https://dashboard.example/auth/gate"));
    expect(response.headers.get("location")).toContain("error=auth_failed");
    expect(response.cookies.get("noelle_email_verified")).toBeUndefined();
    expect(state.sql).not.toHaveBeenCalled();
  });
  it("uses verified identity for first-org lookup and never echoes raw cookie debug data", async () => {
    cookie({ access_token: token({ sub: userId }).replace(/.$/, "!") });
    const response = await firstOrg(
      new Request("https://dashboard.example/api/onboarding/first-org-slug?debug=1"),
    );
    const body = await response.json();
    expect(body.slug).toBeNull();
    expect(Object.keys(body)).toEqual(["slug"]);
    expect(state.sql).not.toHaveBeenCalled();
  });
  it("verifies real ES256/JWKS claims and ignores a contradictory cookie user", async () => {
    cookie({ access_token: token(), user: { id: otherId, email: "unsigned@example.com" } }, true);
    expect(await getUserFromCookies()).toMatchObject({
      id: userId,
      email: "member@example.com",
      user_metadata: { full_name: "Member" },
    });
    expect(await getOrgBySlug("member-org")).toMatchObject({ slug: "member-org" });
    expect(state.assertMember).toHaveBeenCalledWith(expect.anything(), userId, "org");
  });
  it("lets a verified invited member pass the gate using only the signed email identity", async () => {
    cookie({ access_token: token(), user: { id: otherId, email: "another@example.com" } });
    const response = await gate(new NextRequest("https://dashboard.example/auth/gate"));
    expect(response.headers.get("location")).toBe("https://dashboard.example/onboarding");
    expect(
      response.cookies.get("noelle_email_verified")?.value.startsWith("member@example.com."),
    ).toBe(true);
    expect(state.sql.mock.calls[0]?.[1]).toBe("member@example.com");
  });
  it("supports a real HS256 token verified by the configured Auth server", async () => {
    cookie([token({}, "HS256")]);
    expect(await getUserFromCookies()).toMatchObject({ id: userId });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/auth/v1/user"), expect.anything());
  });
  it.each(["ES256", "HS256"])(
    "rejects a tampered %s signature before protected reads",
    async (algorithm) => {
      const jwt = token({}, algorithm);
      const parts = jwt.split(".");
      const bytes = Buffer.from(parts[2]!, "base64url");
      bytes[0] = bytes[0]! ^ 1;
      cookie({ access_token: `${parts[0]}.${parts[1]}.${bytes.toString("base64url")}` });
      await expect(getOrgBySlug("member-org")).rejects.toThrow("not signed in");
      expect(state.sql).not.toHaveBeenCalled();
    },
  );
  it.each([
    { exp: Math.floor(Date.now() / 1000) - 100 },
    { iss: "https://another-project.example/auth/v1" },
    { sub: "" },
    { aud: "service_role" },
  ])("rejects invalid verified session claims %j", async (claims) => {
    cookie({ access_token: token(claims) });
    expect(await getUserFromCookies()).toBeNull();
  });
  it("bounds a stalled Auth verification and fails closed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    cookie({ access_token: token({}, "HS256") });
    const result = getUserFromCookies();
    await vi.advanceTimersByTimeAsync(5100);
    expect(await result).toBeNull();
  });
  it("deduplicates verification only for the same request cookie jar and separates another user", async () => {

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { Hono } from "hono";
import { createApp } from "../app.js";
import { resetEnvForTests } from "../env.js";
import { isOrgMember } from "../lib/auth.js";
import type { AuthContext } from "../middleware/jwt.js";
import { dashboardCap } from "./cap-status.js";

vi.mock("../lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/auth.js")>()),
  isOrgMember: vi.fn(),
}));

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const JWT_SECRET = "test-jwt-secret-test-jwt-secret-0123456789";

async function authHeader(): Promise<string> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(USER_ID)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));
  return `Bearer ${token}`;
}

describe("GET /api/linkedin-review-policy", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.NOELLE_DATABASE_URL = "postgres://noelle_app:test@127.0.0.1:5432/noelle?sslmode=disable";
    process.env.NOELLE_SUPABASE_JWT_SECRET = JWT_SECRET;
    process.env.NOELLE_HMAC_SECRET = "x".repeat(48);
    delete process.env.NOELLE_SUPABASE_JWKS_URL;
    delete process.env.LINKEDIN_AUTOSEND_VOICE_FLOOR;
    resetEnvForTests();
    vi.mocked(isOrgMember).mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.LINKEDIN_AUTOSEND_VOICE_FLOOR;
  });

  it("requires a user JWT", async () => {
    const res = await createApp().request(`/api/linkedin-review-policy?org_id=${ORG_ID}`);
    expect(res.status).toBe(401);
    expect(isOrgMember).not.toHaveBeenCalled();
  });

  it("requires an organization UUID and membership", async () => {
    const authorization = await authHeader();
    const missing = await createApp().request("/api/linkedin-review-policy", { headers: { authorization } });
    expect(missing.status).toBe(400);
    const malformed = await createApp().request("/api/linkedin-review-policy?org_id=bad", { headers: { authorization } });
    expect(malformed.status).toBe(400);
    expect(isOrgMember).not.toHaveBeenCalled();

    vi.mocked(isOrgMember).mockResolvedValue(false);
    const denied = await createApp().request(`/api/linkedin-review-policy?org_id=${ORG_ID}`, { headers: { authorization } });
    expect(denied.status).toBe(403);
    expect(isOrgMember).toHaveBeenCalledWith(USER_ID, ORG_ID);
  });

  it.each([
    [undefined, 0.7],
    ["0.82", 0.82],
  ])("returns the actor's resolved voice floor for %s", async (configured, expected) => {
    if (configured !== undefined) process.env.LINKEDIN_AUTOSEND_VOICE_FLOOR = configured;
    const authorization = await authHeader();
    const res = await createApp().request(`/api/linkedin-review-policy?org_id=${ORG_ID}`, { headers: { authorization } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ org_id: ORG_ID, voice_floor: expected });
  });

  it.each([
    ["-3", 0],
    ["3", 1],
    ["garbage", 0.7],
  ])("clamps an invalid raw floor consistently with the actor for %s", async (configured, expected) => {
    // The full app rejects invalid env values before JWT verification. The
    // route's own resolver remains defensive in the event config changes live.
    process.env.LINKEDIN_AUTOSEND_VOICE_FLOOR = configured;
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use("*", async (c, next) => {
      c.set("auth", { userId: USER_ID, raw: { sub: USER_ID } });
      await next();
    });
    app.route("/", dashboardCap);
    const res = await app.request(`/api/linkedin-review-policy?org_id=${ORG_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ org_id: ORG_ID, voice_floor: expected });
  });
});

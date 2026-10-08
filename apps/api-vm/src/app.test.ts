import { describe, it, expect, beforeEach } from "vitest";
import { resetEnvForTests } from "./env.js";

// Regression: the actuator sub-app must be mounted BEFORE the `user` sub-app,
// whose `use("*", requireUserJwt)` catch-all would otherwise run first for the
// actuator paths and reject the static actuator token with a JWT 401
// (invalid_jwt). These tests exercise the full createApp() wiring — the gap the
// per-route tests missed.
describe("createApp mount order — actuator routes are not shadowed by the JWT catch-all", () => {
  beforeEach(() => {
    resetEnvForTests();
    process.env.NODE_ENV = "test";
    process.env.NOELLE_DATABASE_URL =
      "postgres://noelle_app:test@127.0.0.1:5432/noelle?sslmode=require";
    process.env.NOELLE_HMAC_SECRET = "y".repeat(48);
    process.env.NOELLE_ACTUATOR_TOKEN = "secret-token";
    process.env.NOELLE_ACTUATOR_ORG_ID = "55555555-5555-5555-5555-555555555555";
  });

  async function makeApp() {
    const { createApp } = await import("./app.js");
    return createApp();
  }

  it("a valid actuator token reaches the actuator handler (400 missing_instance_id), not the JWT guard", async () => {
    const app = await makeApp();
    const res = await app.request("/api/actionable-linkedin", {
      headers: { authorization: "Bearer secret-token" },
    });
    // If the JWT catch-all shadowed the route this would be 401 invalid_jwt.
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_instance_id" });
  });

  it("a wrong actuator token is rejected by requireActuatorToken (invalid_token), not requireUserJwt (invalid_jwt)", async () => {
    const app = await makeApp();
    const res = await app.request("/api/actionable-linkedin?instanceId=x", {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  it("routes the X discovery token before the JWT catch-all", async () => {
    const app = await makeApp();
    const res = await app.request("/api/x-actuator/discovery-target", {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_instance_id" });
  });

  it("CORS preflight (OPTIONS) is answered 204 with Private-Network header, BEFORE auth", async () => {
    const app = await makeApp();
    const res = await app.request("/api/actionable-linkedin?instanceId=x", {
      method: "OPTIONS",
      headers: {
        origin: "chrome-extension://abc",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
        "access-control-request-private-network": "true",
      },
    });
    // Must NOT be 401 (no token on a preflight) — and must allow private network.
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
    expect(res.headers.get("access-control-allow-origin")).toBe("chrome-extension://abc");
  });

  it.each(["PATCH", "DELETE"])("admits the actual %s route method during browser preflight", async method => {
    const app = await makeApp();
    const res = await app.request("/api/content/slots/00000000-0000-4000-8000-000000000011", {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:19001",
        "access-control-request-method": method,
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")?.split(",")).toContain(method);
    expect(res.headers.get("access-control-allow-headers")).toBe("authorization,content-type");
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
    const actual = await app.request("/api/content/slots/00000000-0000-4000-8000-000000000011", { method });
    expect(actual.status).toBe(401);
  });
});

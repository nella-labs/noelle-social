import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type { ActuatorContext } from "./actuator.js";
import { resetEnvForTests } from "../env.js";

describe("requireActuatorToken", () => {
  beforeEach(() => {
    resetEnvForTests();
    // Minimal required fields to satisfy the Zod schema.
    process.env.NODE_ENV = "test";
    process.env.NOELLE_DATABASE_URL =
      "postgres://noelle_app:test@127.0.0.1:5432/noelle?sslmode=require";
    process.env.NOELLE_HMAC_SECRET = "y".repeat(48);
    process.env.NOELLE_ACTUATOR_TOKEN = "secret-token";
    process.env.NOELLE_ACTUATOR_ORG_ID = "55555555-5555-5555-5555-555555555555";
  });

  async function appWith() {
    const { requireActuatorToken } = await import("./actuator.js");
    const app = new Hono<{ Variables: { actuator: ActuatorContext } }>();
    app.use("*", requireActuatorToken);
    app.get("/x", (c) => c.json({ orgId: c.get("actuator").orgId }));
    return app;
  }

  it("401s without a bearer token", async () => {
    const app = await appWith();
    const res = await app.request("/x");
    expect(res.status).toBe(401);
  });

  it("401s with a wrong token", async () => {
    const app = await appWith();
    const res = await app.request("/x", { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("passes with the right token and exposes orgId", async () => {
    const app = await appWith();
    const res = await app.request("/x", { headers: { authorization: "Bearer secret-token" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: "55555555-5555-5555-5555-555555555555" });
  });
});

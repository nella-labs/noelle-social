import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { resetEnvForTests } from "../env.js";
import { signHmacBody } from "../middleware/hmac.js";

const HMAC_SECRET = "x".repeat(48);

beforeAll(() => {
  process.env.PORT = "18791";
  process.env.NODE_ENV = "test";
  // Cloud SQL connection string — never dialled in this test file; the
  // routes exercised here all 401 before hitting the db. Still required by
  // the env Zod schema.
  process.env.NOELLE_DATABASE_URL =
    "postgres://noelle_app:test@127.0.0.1:5432/noelle?sslmode=require";
  process.env.NOELLE_SUPABASE_JWT_SECRET = "test-jwt-secret";
  process.env.NOELLE_HMAC_SECRET = HMAC_SECRET;
  delete process.env.NOELLE_SUPABASE_URL;
  delete process.env.NOELLE_SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.OPENCLAW_SUPABASE_URL;
  delete process.env.OPENCLAW_SUPABASE_SERVICE_ROLE_KEY;
  resetEnvForTests();
});

describe("api-vm Hono service", () => {
  it("GET /health returns 200", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, service: "noelle-api-vm" });
  });

  it("user route returns 401 when bearer token missing", async () => {
    const app = createApp();
    const res = await app.request("/api/drafts/some-id/send", {
      method: "POST",
      body: JSON.stringify({ body: "x" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("HMAC route returns 401 when signature missing", async () => {
    const app = createApp();
    const res = await app.request("/api/outbound", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("HMAC route returns 401 when signature mismatches", async () => {
    const app = createApp();
    const ts = Math.floor(Date.now() / 1000);
    const res = await app.request("/api/outbound", {
      method: "POST",
      body: "{}",
      headers: {
        "content-type": "application/json",
        "x-noelle-timestamp": String(ts),
        "x-noelle-signature": "sha256=deadbeef",
      },
    });
    expect(res.status).toBe(401);
  });

  it("HMAC route accepts a valid signature and rejects an empty body with 400", async () => {
    const app = createApp();
    const body = "{}";
    const ts = Math.floor(Date.now() / 1000);
    const { signature } = signHmacBody(HMAC_SECRET, ts, body);
    const res = await app.request("/api/outbound", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-noelle-timestamp": String(ts),
        "x-noelle-signature": signature,
      },
    });
    // Past HMAC, but `{}` fails OutboundInSchema validation.
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid_body");
  });

  it("HMAC route rejects timestamps outside the 5-minute window", async () => {
    const app = createApp();
    const body = "{}";
    const ts = Math.floor(Date.now() / 1000) - 600;
    const { signature } = signHmacBody(HMAC_SECRET, ts, body);
    const res = await app.request("/api/outbound", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-noelle-timestamp": String(ts),
        "x-noelle-signature": signature,
      },
    });
    expect(res.status).toBe(401);
  });
});

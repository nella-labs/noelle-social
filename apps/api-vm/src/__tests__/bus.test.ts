import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { resetEnvForTests } from "../env.js";
import { signHmacBody } from "../middleware/hmac.js";

const HMAC_SECRET = "x".repeat(48);

beforeAll(() => {
  process.env.PORT = "18793";
  process.env.NODE_ENV = "test";
  // Never dialled here — every assertion 401s/400s before touching the db.
  process.env.NOELLE_DATABASE_URL =
    "postgres://noelle_app:test@127.0.0.1:5432/noelle?sslmode=require";
  process.env.NOELLE_SUPABASE_JWT_SECRET = "test-jwt-secret";
  process.env.NOELLE_HMAC_SECRET = HMAC_SECRET;
  delete process.env.NOELLE_SUPABASE_URL;
  delete process.env.NOELLE_SUPABASE_SERVICE_ROLE_KEY;
  resetEnvForTests();
});

describe("bus routes", () => {
  it("GET /api/bus/events 401s without a bearer token (JWT-gated)", async () => {
    const res = await createApp().request("/api/bus/events?org_id=x");
    expect(res.status).toBe(401);
  });

  it("GET /api/bus/state 401s without a bearer token (JWT-gated)", async () => {
    const res = await createApp().request("/api/bus/state?org_id=x");
    expect(res.status).toBe(401);
  });

  it("POST /api/bus/emit 401s without an HMAC signature (HMAC-gated)", async () => {
    const res = await createApp().request("/api/bus/emit", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/bus/emit accepts a valid signature, then 400s on an invalid body", async () => {
    const body = "{}";
    const ts = Math.floor(Date.now() / 1000);
    const { signature } = signHmacBody(HMAC_SECRET, ts, body);
    const res = await createApp().request("/api/bus/emit", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-noelle-timestamp": String(ts),
        "x-noelle-signature": signature,
      },
    });
    expect(res.status).toBe(400); // past HMAC; fails BusEmitInSchema
    expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
  });

  // Route-shadow regression: POST /api/bus/state (HMAC) and GET /api/bus/state
  // (JWT) share a path. A path-glob `vm.use("/api/bus/*", requireHmac)` would
  // wrongly HMAC-gate the GET (use is method-agnostic + vm mounts first). With
  // per-route HMAC middleware, a GET carrying VALID HMAC headers but no bearer
  // must still 401 from the JWT gate — proving it is NOT HMAC-shadowed.
  it("GET /api/bus/state is not shadowed by the HMAC POST on the same path", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const { signature } = signHmacBody(HMAC_SECRET, ts, "");
    const res = await createApp().request("/api/bus/state?org_id=x", {
      headers: {
        "x-noelle-timestamp": String(ts),
        "x-noelle-signature": signature,
      },
    });
    expect(res.status).toBe(401); // JWT gate, not HMAC
  });
});

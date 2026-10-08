import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import type { Sql } from "postgres";
import { SystemStatusSchema, type SystemStatus } from "@noelle/contracts";
import { createApp } from "../app.js";
import { resetEnvForTests } from "../env.js";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";

// HS256 requires a >=256-bit (32-byte) key; jose rejects shorter ones.
const JWT_SECRET = "test-jwt-secret-test-jwt-secret-0123456789";

beforeAll(() => {
  process.env.PORT = "18791";
  process.env.NODE_ENV = "test";
  process.env.NOELLE_DATABASE_URL =
    "postgres://noelle_app:test@127.0.0.1:5432/noelle?sslmode=disable";
  process.env.NOELLE_SUPABASE_JWT_SECRET = JWT_SECRET;
  process.env.NOELLE_HMAC_SECRET = "x".repeat(48);
  delete process.env.NOELLE_SUPABASE_JWKS_URL;
  resetEnvForTests();
});

afterEach(() => {
  resetDbClientForTests();
});

async function mintToken(): Promise<string> {
  return new SignJWT({ email: "operator@localhost" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("be2fb26e-5b29-40d8-a593-a5642b3d49b3")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

/** Stub postgres.js tagged-template client — every query resolves to []. */
function emptyDbStub(): Sql {
  return ((..._args: unknown[]) => Promise.resolve([])) as unknown as Sql;
}

describe("GET /api/system/status", () => {
  it("401s without a bearer token", async () => {
    const app = createApp();
    const res = await app.request("/api/system/status");
    expect(res.status).toBe(401);
  });

  it("returns a schema-valid SystemStatus for an authed operator", async () => {
    __setDbClientForTests(emptyDbStub());
    const token = await mintToken();
    const app = createApp();
    const res = await app.request("/api/system/status", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SystemStatus;
    const parsed = SystemStatusSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body.service).toBe("noelle-self-host");
    // Postgres probe used the stub (resolved []), so it reports ok.
    const pg = body.services.find((s) => s.name === "postgres");
    expect(pg?.state).toBe("ok");
    // All four workers present, disabled by default (NOELLE_WORKERS_ENABLED unset).
    expect(body.workerRuns).toHaveLength(4);
    expect(body.workerRuns.every((w) => w.enabled === false)).toBe(true);
  });

  it("reports postgres down when the probe throws", async () => {
    const failing = ((..._args: unknown[]) =>
      Promise.reject(new Error("ECONNREFUSED"))) as unknown as Sql;
    __setDbClientForTests(failing);
    const token = await mintToken();
    const app = createApp();
    const res = await app.request("/api/system/status", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SystemStatus;
    expect(body.ok).toBe(false);
    const pg = body.services.find((s) => s.name === "postgres");
    expect(pg?.state).toBe("down");
  });
});

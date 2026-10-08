import { describe, it, expect } from "vitest";
import { decideCronAuth } from "./cron-auth";

describe("decideCronAuth", () => {
  const SECRET = "s3cr3t";
  it("allows a matching Bearer when secret is set", () => {
    expect(decideCronAuth({ authHeader: `Bearer ${SECRET}`, cronSecret: SECRET, isProduction: true, allowUnauthenticated: false })).toEqual({ ok: true });
  });
  it("rejects a wrong Bearer when secret is set (prod)", () => {
    expect(decideCronAuth({ authHeader: "Bearer nope", cronSecret: SECRET, isProduction: true, allowUnauthenticated: false })).toEqual({ ok: false, status: 401, code: "invalid_cron_secret" });
  });
  it("rejects a missing header when secret is set", () => {
    expect(decideCronAuth({ authHeader: null, cronSecret: SECRET, isProduction: true, allowUnauthenticated: false })).toEqual({ ok: false, status: 401, code: "invalid_cron_secret" });
  });
  it("FAILS CLOSED in production when secret is unset", () => {
    expect(decideCronAuth({ authHeader: null, cronSecret: undefined, isProduction: true, allowUnauthenticated: false })).toEqual({ ok: false, status: 401, code: "cron_secret_unset" });
  });
  it("secret set + wrong bearer still rejects even if allowUnauthenticated=true (flag only affects the unset case)", () => {
    expect(decideCronAuth({ authHeader: "Bearer nope", cronSecret: SECRET, isProduction: true, allowUnauthenticated: true })).toEqual({ ok: false, status: 401, code: "invalid_cron_secret" });
  });
  it("escape hatch: unset secret + allowUnauthenticated=true allows in prod", () => {
    expect(decideCronAuth({ authHeader: null, cronSecret: undefined, isProduction: true, allowUnauthenticated: true })).toEqual({ ok: true });
  });
  it("dev convenience: unset secret + non-production allows", () => {
    expect(decideCronAuth({ authHeader: null, cronSecret: undefined, isProduction: false, allowUnauthenticated: false })).toEqual({ ok: true });
  });
});

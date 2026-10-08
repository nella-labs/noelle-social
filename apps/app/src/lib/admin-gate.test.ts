import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ sql: vi.fn() }));
vi.mock("@/lib/queries", () => ({ getCurrentUser: vi.fn() }));

import { isPrimaryAdminEmail } from "./admin-gate";

afterEach(() => vi.unstubAllEnvs());

describe("installation owner access", () => {
  it("fails closed when a hosted installation has no configured owner", () => {
    vi.stubEnv("NOELLE_AUTH_MODE", "supabase");
    vi.stubEnv("NOELLE_PRIMARY_ADMIN_EMAIL", "");
    expect(isPrimaryAdminEmail("operator@example.com")).toBe(false);
    expect(isPrimaryAdminEmail(null)).toBe(false);
  });

  it("matches only the configured verified account after normalization", () => {
    vi.stubEnv("NOELLE_AUTH_MODE", "supabase");
    vi.stubEnv("NOELLE_PRIMARY_ADMIN_EMAIL", " Owner@Example.com ");
    expect(isPrimaryAdminEmail("owner@example.com")).toBe(true);
    expect(isPrimaryAdminEmail("other@example.com")).toBe(false);
  });

  it("uses the local operator only in local authentication mode", () => {
    vi.stubEnv("NOELLE_AUTH_MODE", "local");
    vi.stubEnv("NOELLE_PRIMARY_ADMIN_EMAIL", "");
    vi.stubEnv("NOELLE_LOCAL_OPERATOR_EMAIL", "local@example.com");
    expect(isPrimaryAdminEmail("local@example.com")).toBe(true);
    expect(isPrimaryAdminEmail("operator@example.com")).toBe(false);
  });
});

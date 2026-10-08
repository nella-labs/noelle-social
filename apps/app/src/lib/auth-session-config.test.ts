import { describe, expect, it } from "vitest";
import { authSessionCookieName } from "./auth-session-config";

describe("configured auth cookie identity", () => {
  it("matches the auth client's default key for distinct projects", () => {
    expect(authSessionCookieName("https://first.supabase.co")).toBe("sb-first-auth-token");
    expect(authSessionCookieName("https://second.supabase.co")).toBe("sb-second-auth-token");
  });
  it("supports a custom auth hostname", () => {
    expect(authSessionCookieName("https://auth.example.com")).toBe("sb-auth-auth-token");
  });
  it("does not fall back to a built-in project when configuration is invalid", () => {
    expect(authSessionCookieName("invalid")).toBe("sb-unconfigured-auth-token");
  });
});

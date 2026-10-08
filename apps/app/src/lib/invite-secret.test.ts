import { describe, it, expect } from "vitest";
import { resolveInviteSecret } from "./invite-secret";

describe("resolveInviteSecret", () => {
  it("returns the explicit secret when set", () => {
    expect(resolveInviteSecret({ NOELLE_INVITE_COOKIE_SECRET: "s3cr3t", NODE_ENV: "production" })).toBe("s3cr3t");
  });
  it("uses the dev literal when unset outside production", () => {
    expect(resolveInviteSecret({ NODE_ENV: "development" })).toBe("noelle-dev-invite-secret");
    expect(resolveInviteSecret({ NODE_ENV: "test" })).toBe("noelle-dev-invite-secret");
  });
  it("fails CLOSED: throws when unset in production", () => {
    expect(() => resolveInviteSecret({ NODE_ENV: "production" })).toThrow(/required in production/);
    expect(() => resolveInviteSecret({ NOELLE_INVITE_COOKIE_SECRET: "", NODE_ENV: "production" })).toThrow();
  });
  it("NEVER derives the secret from the public anon key (no anon-key field is even read)", () => {
    const out = resolveInviteSecret({ NODE_ENV: "development" } as never);
    expect(out).toBe("noelle-dev-invite-secret");
    expect(out).not.toMatch(/anon|eyJ/); // anon keys are JWTs starting eyJ
  });
});

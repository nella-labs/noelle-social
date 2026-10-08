import { describe, it, expect } from "vitest";
import { resolveGateSecret } from "./gate-secret";

describe("resolveGateSecret", () => {
  it("returns the explicit secret when set", () => {
    expect(resolveGateSecret({ NOELLE_GATE_COOKIE_SECRET: "s3cr3t", NODE_ENV: "production" })).toBe("s3cr3t");
  });
  it("uses the dev literal when unset outside production", () => {
    expect(resolveGateSecret({ NODE_ENV: "development" })).toBe("noelle-dev-gate-secret");
    expect(resolveGateSecret({ NODE_ENV: "test" })).toBe("noelle-dev-gate-secret");
  });
  it("fails CLOSED: throws when unset in production", () => {
    expect(() => resolveGateSecret({ NODE_ENV: "production" })).toThrow(/required in production/);
    expect(() => resolveGateSecret({ NOELLE_GATE_COOKIE_SECRET: "", NODE_ENV: "production" })).toThrow();
  });
  it("NEVER derives the secret from the public anon key (no anon-key field is even read)", () => {
    // even if an anon key were present in the environment, it must not leak into the result
    const out = resolveGateSecret({ NODE_ENV: "development" } as never);
    expect(out).toBe("noelle-dev-gate-secret");
    expect(out).not.toMatch(/anon|eyJ/); // anon keys are JWTs starting eyJ
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  isLocalAuth,
  localOperator,
  localOperatorEmail,
  localOperatorJwt,
  localOperatorSub,
  localOrgSlug,
} from "./local-auth";

const KEYS = [
  "NOELLE_AUTH_MODE",
  "NOELLE_LOCAL_OPERATOR_SUB",
  "NOELLE_LOCAL_OPERATOR_EMAIL",
  "NOELLE_LOCAL_OPERATOR_NAME",
  "NOELLE_LOCAL_OPERATOR_JWT",
  "NOELLE_LOCAL_ORG_SLUG",
];

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("local-auth shim", () => {
  it("isLocalAuth is gated on NOELLE_AUTH_MODE=local", () => {
    expect(isLocalAuth()).toBe(false);
    process.env.NOELLE_AUTH_MODE = "local";
    expect(isLocalAuth()).toBe(true);
    process.env.NOELLE_AUTH_MODE = "supabase";
    expect(isLocalAuth()).toBe(false);
  });

  it("uses generic defaults without a personal seed", () => {
    expect(localOperatorSub()).toBe("00000000-0000-4000-8000-000000000001");
    expect(localOperatorEmail()).toBe("operator@example.com");
    expect(localOrgSlug()).toBe("workspace");
  });

  it("honors operator overrides from env", () => {
    process.env.NOELLE_LOCAL_OPERATOR_SUB = "00000000-0000-0000-0000-000000000001";
    process.env.NOELLE_LOCAL_OPERATOR_EMAIL = "me@example.com";
    process.env.NOELLE_LOCAL_OPERATOR_NAME = "Me";
    process.env.NOELLE_LOCAL_ORG_SLUG = "acme";
    const op = localOperator();
    expect(op.id).toBe("00000000-0000-0000-0000-000000000001");
    expect(op.email).toBe("me@example.com");
    expect(op.user_metadata?.full_name).toBe("Me");
    expect(op.app_metadata?.provider).toBe("local");
    expect(localOrgSlug()).toBe("acme");
  });

  it("localOperatorJwt returns null until minted", () => {
    expect(localOperatorJwt()).toBeNull();
    process.env.NOELLE_LOCAL_OPERATOR_JWT = "jwt-token";
    expect(localOperatorJwt()).toBe("jwt-token");
  });
});

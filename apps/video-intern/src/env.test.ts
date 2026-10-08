import { expect, it } from "vitest";
import { loadEnv, resetEnvForTests } from "./env.js";


it("keeps local retrieval free of implicit remote workspace defaults", () => {
  const original = process.env;
  try {
    process.env = { NOELLE_DATABASE_URL: "postgres://localhost/noelle", NOELLE_HMAC_SECRET: "x".repeat(32), NOELLE_NELLA_BACKEND: "local", NOELLE_VAULT_DIR: "/voice-vault" };
    resetEnvForTests();
    expect(loadEnv().NELLA_WORKSPACE).toBe("");
    process.env.NELLA_WORKSPACE = " configured-workspace ";
    resetEnvForTests();
    expect(loadEnv().NELLA_WORKSPACE).toBe("configured-workspace");
  } finally {
    process.env = original;
    resetEnvForTests();
  }
});

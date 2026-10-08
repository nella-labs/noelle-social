import { afterEach, describe, expect, it } from "vitest";
import { createSecretsClient, SecretAccessError, secretIdToEnvKey } from "./index.js";

describe("secretIdToEnvKey", () => {
  it("maps a secret id to an upper-snake NOELLE_SECRET_ var", () => {
    expect(secretIdToEnvKey("noelle-postgres-app-password")).toBe(
      "NOELLE_SECRET_NOELLE_POSTGRES_APP_PASSWORD",
    );
    expect(secretIdToEnvKey("noelle--org--abc--x-cookies")).toBe(
      "NOELLE_SECRET_NOELLE__ORG__ABC__X_COOKIES",
    );
  });
});

describe("createSecretsClient source:'env'", () => {
  const touched: string[] = [];
  function setEnv(key: string, value: string) {
    process.env[key] = value;
    touched.push(key);
  }
  afterEach(() => {
    for (const k of touched.splice(0)) delete process.env[k];
    delete process.env.NOELLE_SECRETS_SOURCE;
  });

  it("reads a secret from process.env via the mapping", async () => {
    setEnv("NOELLE_SECRET_NOELLE_HMAC_SECRET", "hmac-value");
    const secrets = createSecretsClient({ project: "noelle-agents", source: "env" });
    expect(await secrets.get("noelle-hmac-secret")).toBe("hmac-value");
  });

  it("throws NOT_FOUND SecretAccessError when the env var is absent", async () => {
    const secrets = createSecretsClient({ project: "noelle-agents", source: "env" });
    await expect(secrets.get("does-not-exist")).rejects.toBeInstanceOf(SecretAccessError);
    await expect(secrets.get("does-not-exist")).rejects.toThrow(/NOT_FOUND/);
  });

  it("is selected by NOELLE_SECRETS_SOURCE=env without an explicit source", async () => {
    process.env.NOELLE_SECRETS_SOURCE = "env";
    setEnv("NOELLE_SECRET_FOO_BAR", "baz");
    const secrets = createSecretsClient({ project: "noelle-agents" });
    expect(await secrets.get("foo-bar")).toBe("baz");
  });

  it("getForOrg falls back to the legacy flat name in env mode", async () => {
    // No per-org var; only the legacy noelle-worker-<fragment> var is set.
    setEnv("NOELLE_SECRET_NOELLE_WORKER_ANTHROPIC_API_KEY", "sk-ant-legacy");
    const secrets = createSecretsClient({ project: "noelle-agents", source: "env" });
    expect(await secrets.getForOrg("org-123", "anthropic-api-key")).toBe("sk-ant-legacy");
  });

  it("caches within the TTL (env var change not observed until expiry)", async () => {
    let t = 0;
    setEnv("NOELLE_SECRET_ROT", "v1");
    const secrets = createSecretsClient({
      project: "noelle-agents",
      source: "env",
      ttlMs: 1000,
      now: () => t,
    });
    expect(await secrets.get("rot")).toBe("v1");
    process.env.NOELLE_SECRET_ROT = "v2";
    expect(await secrets.get("rot")).toBe("v1"); // cached
    t = 2000;
    expect(await secrets.get("rot")).toBe("v2"); // expired → re-read
  });
});

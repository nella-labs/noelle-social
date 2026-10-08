import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import {
  composeEnv,
  readEnvFile,
  serializeEnv,
  upsertEnvKey,
  writeEnvFile,
  type EnvInputs,
} from "./env-writer.js";
import { defaultConfig, paths } from "../config.js";
import { generateEcosystem } from "./process-manager.js";
import { collectProviderEnv, collectWorkerCredsEnv } from "./providers.js";

function inputs(overrides: Partial<EnvInputs> = {}): EnvInputs {
  return {
    config: defaultConfig(),
    databaseUrl: "postgres://noelle_app:pw@127.0.0.1:5432/postgres?sslmode=disable",
    jwtSecret: "jwt-secret",
    gateCookieSecret: "gate-secret",
    hmacSecret: "x".repeat(48),
    cronSecret: "cron-secret",
    operatorJwt: "minted.jwt.token",
    version: "0.0.1-test",
    heartbeatDir: "/home/op/.noelle/heartbeats",
    providerEnv: { ANTHROPIC_API_KEY: "sk-ant-x" },
    tunnelHostname: null,
    ...overrides,
  };
}

describe("composeEnv", () => {
  it("sets the local-mode switches", () => {
    const env = composeEnv(inputs());
    expect(env.NOELLE_AUTH_MODE).toBe("local");
    expect(env.CRON_SECRET).toBe("cron-secret");
    expect(env.NOELLE_SECRETS_SOURCE).toBe("env");
    expect(env.NOELLE_DATABASE_URL).toContain("sslmode=disable");
    expect(env.NOELLE_API_BASE_URL).toBe("http://127.0.0.1:18791");
    expect(env.NOELLE_LOCAL_OPERATOR_JWT).toBe("minted.jwt.token");
  });

  it("NEVER emits the WIF quintuple (would force the GCP DB connector)", () => {
    const env = composeEnv(inputs());
    for (const k of [
      "NOELLE_GCP_PROJECT_NUMBER",
      "NOELLE_GCP_POOL_ID",
      "NOELLE_GCP_PROVIDER_ID",
      "NOELLE_GCP_SA_EMAIL",
      "NOELLE_CLOUDSQL_INSTANCE",
    ]) {
      expect(env[k]).toBeUndefined();
    }
  });

  it("passes provider creds through verbatim", () => {
    const env = composeEnv(inputs({ providerEnv: { OPENAI_API_KEY: "sk-openai" } }));
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
  });

  it("classifies on Bedrock when AWS creds are present (self-host Vertex is unreliable)", () => {
    const env = composeEnv(
      inputs({ providerEnv: { AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "s" } }),
    );
    expect(env.NOELLE_CLASSIFIER_BACKEND).toBe("bedrock");
  });

  it("uses the self-host Gemini key for classification even when AWS creds are present", () => {
    const env = composeEnv(
      inputs({
        providerEnv: {
          AWS_ACCESS_KEY_ID: "AKIA",
          AWS_SECRET_ACCESS_KEY: "s",
          NOELLE_GEMINI_API_KEY: "AIza-test",
        },
      }),
    );
    expect(env.NOELLE_CLASSIFIER_BACKEND).toBe("vertex");
  });

  it("leaves the classifier on the default (vertex) when no AWS creds", () => {
    const env = composeEnv(inputs({ providerEnv: { OPENAI_API_KEY: "sk-openai" } }));
    expect(env.NOELLE_CLASSIFIER_BACKEND).toBeUndefined();
  });

  it("sets codex/vertex flags only for those providers", () => {
    const codex = composeEnv(inputs({ config: { ...defaultConfig(), llmProvider: "codex" } }));
    expect(codex.NOELLE_CODEX_ENABLED).toBe("1");
    expect(codex.NOELLE_CODEX_CLI).toBe("1");
    expect(codex.NOELLE_CODEX_PRIMARY).toBe("1");
    const anthropic = composeEnv(inputs());
    expect(anthropic.NOELLE_CODEX_ENABLED).toBeUndefined();
    expect(anthropic.NOELLE_CODEX_CLI).toBeUndefined();
    expect(anthropic.NOELLE_CODEX_PRIMARY).toBeUndefined();
    expect(anthropic.NOELLE_VERTEX_ENABLED).toBeUndefined();
  });

  it("writes supplied Codex settings into the generated worker environment", () => {
    const source = {
      NOELLE_CODEX_CLI_MODEL: "gpt-5.6-sol",
      NOELLE_CODEX_CLI_PATH: "/home/operator/My Tools/codex",
      NOELLE_CODEX_CLI_TIMEOUT_MS: "90000",
    };
    const dir = mkdtempSync(resolve(tmpdir(), "noelle-codex-init-"));
    try {
      const path = resolve(dir, ".env");
      writeEnvFile(path, composeEnv(inputs({
        config: { ...defaultConfig(), llmProvider: "codex" },
        providerEnv: {
          ...collectProviderEnv("codex", source).env,
          ...collectWorkerCredsEnv(source),
        },
      })));
      expect(readEnvFile(path)).toMatchObject({
        NOELLE_CODEX_PRIMARY: "1",
        NOELLE_CODEX_CLI_MODEL: "gpt-5.6-sol",
        NOELLE_CODEX_CLI_PATH: "/home/operator/My Tools/codex",
        NOELLE_CODEX_CLI_TIMEOUT_MS: "90000",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes the tunnel hostname when present", () => {
    const env = composeEnv(inputs({ tunnelHostname: "abc.trycloudflare.com" }));
    expect(env.NOELLE_TUNNEL_HOSTNAME).toBe("abc.trycloudflare.com");
  });

  it("scopes the local vault to the curated voice dirs when voiceDirs is set", () => {
    const env = composeEnv(
      inputs({
        config: {
          ...defaultConfig(),
          vaultDir: "/home/op/mars",
          voiceDirs: "noelle-voice,content/voice-anchors,02-brand",
        },
      }),
    );
    expect(env.NOELLE_VAULT_DIR).toBe("/home/op/mars");
    expect(env.NOELLE_VOICE_DIRS).toBe("noelle-voice,content/voice-anchors,02-brand");
  });

  it("omits NOELLE_VOICE_DIRS when voiceDirs is unset (drafter indexes the whole vault)", () => {
    const env = composeEnv(inputs({ config: { ...defaultConfig(), vaultDir: "/home/op/mars" } }));
    expect(env.NOELLE_VAULT_DIR).toBe("/home/op/mars");
    expect(env.NOELLE_VOICE_DIRS).toBeUndefined();
  });

  it("workersEnabled toggles NOELLE_WORKERS_ENABLED", () => {
    const off = composeEnv(inputs());
    expect(off.NOELLE_WORKERS_ENABLED).toBe("0");
    const on = composeEnv(inputs({ config: { ...defaultConfig(), workersEnabled: true } }));
    expect(on.NOELLE_WORKERS_ENABLED).toBe("1");
  });
});

describe("serializeEnv", () => {
  it("quotes values with special characters and leaves simple ones bare", () => {
    const out = serializeEnv({ SIMPLE: "abc123", URL: "postgres://u:p@h/db?x=1", SPACED: "a b" });
    expect(out).toContain("SIMPLE=abc123");
    expect(out).toContain("URL=postgres://u:p@h/db?x=1");
    expect(out).toContain('SPACED="a b"');
  });

  it("prepends a documentation header that the env parsers ignore", () => {
    const out = serializeEnv({ FOO: "bar", NOELLE_VAULT_DIR: "/v" });
    expect(out.startsWith("#")).toBe(true);
    expect(out).toContain("NOELLE_VOICE_DIRS");
    expect(out).toContain("docs/self-host.md");
    // The exact regex the ecosystem parser + readEnvFile use must skip the
    // comment lines and surface only the real KEY=value pairs.
    const parsed: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) parsed[m[1]!] = m[2]!;
    }
    expect(parsed).toEqual({ FOO: "bar", NOELLE_VAULT_DIR: "/v" });
  });
});

describe("upsertEnvKey", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  function envFile(body?: string): string {
    const d = mkdtempSync(resolve(tmpdir(), "noelle-env-"));
    dirs.push(d);
    const p = resolve(d, ".env");
    if (body !== undefined) writeFileSync(p, body, { mode: 0o600 });
    return p;
  }

  it("replaces just the target key, preserving comments/order/other keys", () => {
    const p = envFile("# header comment\nA=1\nNOELLE_LOCAL_OPERATOR_JWT=old.jwt.value\nB=two words no quotes broken\n");

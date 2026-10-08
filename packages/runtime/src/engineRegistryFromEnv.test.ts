import { afterEach, describe, expect, it } from "vitest";
import { buildEngineRegistry, type SecretGetter } from "./engineRegistryFromEnv.js";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "NOELLE_VERTEX_ENABLED",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "NOELLE_CLAUDE_CLI",
  "NOELLE_CLAUDE_CLI_PATH",
  "NOELLE_CLAUDE_CLI_TIMEOUT_MS",
];

function snapshotEnv() {
  const prev: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prev[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  return prev;
}

let restore: Record<string, string | undefined> | null = null;
afterEach(() => {
  if (restore) {
    for (const k of ENV_KEYS) {
      if (restore[k] === undefined) delete process.env[k];
      else process.env[k] = restore[k];
    }
    restore = null;
  }
});

/** A secrets stub that resolves only the ids it is given; else NOT_FOUND. */
function secretsWith(map: Record<string, string>): SecretGetter {
  return {
    async get(name) {
      if (name in map) return map[name]!;
      throw Object.assign(new Error(`NOT_FOUND ${name}`), { code: 5 });
    },
  };
}

describe("buildEngineRegistry", () => {
  it("wires only engines whose credentials are present (env BYOK)", async () => {
    restore = snapshotEnv();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const registry = await buildEngineRegistry();
    expect(Object.keys(registry).sort()).toEqual(["claude"]);
  });

  it("wires bedrock from AWS env credential pair", async () => {
    restore = snapshotEnv();
    process.env.AWS_ACCESS_KEY_ID = "AKIA";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    const registry = await buildEngineRegistry();
    expect(Object.keys(registry)).toContain("bedrock");
  });

  it("does not wire bedrock with only half the AWS pair", async () => {
    restore = snapshotEnv();
    process.env.AWS_ACCESS_KEY_ID = "AKIA";
    const registry = await buildEngineRegistry();
    expect(Object.keys(registry)).not.toContain("bedrock");
  });

  it("reads keys from the secrets source when present", async () => {
    restore = snapshotEnv();
    const secrets = secretsWith({
      "noelle-worker-anthropic-api-key": "sk-ant-from-secrets",
      "noelle-worker-openai-api-key": "sk-from-secrets",
    });
    const registry = await buildEngineRegistry({ secrets });
    expect(Object.keys(registry).sort()).toEqual(["claude", "openai"]);
  });

  it("leaves vertex off by default, on when NOELLE_VERTEX_ENABLED=1", async () => {
    restore = snapshotEnv();
    let registry = await buildEngineRegistry();
    expect(Object.keys(registry)).not.toContain("vertex");

    process.env.NOELLE_VERTEX_ENABLED = "1";
    registry = await buildEngineRegistry();
    expect(Object.keys(registry)).toContain("vertex");
  });

  it("respects enable:false to suppress an otherwise-credentialed engine", async () => {
    restore = snapshotEnv();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const registry = await buildEngineRegistry({ enable: { claude: false } });
    expect(Object.keys(registry)).not.toContain("claude");
  });

  it("returns an empty registry when nothing is configured", async () => {
    restore = snapshotEnv();
    const registry = await buildEngineRegistry();
    expect(Object.keys(registry)).toEqual([]);
  });
});

describe("buildEngineRegistry claude-cli", () => {
  it("wires claude-cli only when NOELLE_CLAUDE_CLI=1", async () => {
    restore = snapshotEnv();
    let registry = await buildEngineRegistry();
    expect(Object.keys(registry)).not.toContain("claude-cli");

    process.env.NOELLE_CLAUDE_CLI = "1";
    registry = await buildEngineRegistry();
    expect(Object.keys(registry)).toContain("claude-cli");
  });

  it("respects enable:false to suppress claude-cli even with the flag set", async () => {
    restore = snapshotEnv();
    process.env.NOELLE_CLAUDE_CLI = "1";
    const registry = await buildEngineRegistry({ enable: { "claude-cli": false } });
    expect(Object.keys(registry)).not.toContain("claude-cli");
  });
});

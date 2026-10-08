import { describe, expect, it } from "vitest";
import { collectWorkerCredsEnv } from "./providers.js";

describe("collectWorkerCredsEnv", () => {
  it("preserves the server-only AI Gateway key across noelle init", () => {
    expect(collectWorkerCredsEnv({ AI_GATEWAY_API_KEY: "gateway-test" }))
      .toEqual({ AI_GATEWAY_API_KEY: "gateway-test" });
  });
  it("preserves a direct TypeSafe Jev key across noelle init", () => {
    expect(collectWorkerCredsEnv({ TYPESAFE_API_KEY: "direct-test" }))
      .toEqual({ TYPESAFE_API_KEY: "direct-test" });
  });
  it("preserves the self-host Gemini key used by classifiers", () => {
    expect(
      collectWorkerCredsEnv({ NOELLE_GEMINI_API_KEY: "AIza-test" }),
    ).toEqual({ NOELLE_GEMINI_API_KEY: "AIza-test" });
  });

  it.each([
    ["NOELLE_CODEX_CLI_MODEL", "gpt-5.6-sol"],
    ["NOELLE_CODEX_CLI_PATH", "/home/operator/My Tools/codex"],
    ["NOELLE_CODEX_CLI_TIMEOUT_MS", "90000"],
  ])("preserves an explicitly supplied %s", (key, value) => {
    expect(collectWorkerCredsEnv({ [key]: value })).toEqual({ [key]: value });
  });

  it("leaves absent or empty Codex settings to the runtime defaults", () => {
    expect(collectWorkerCredsEnv({
      NOELLE_CODEX_CLI_MODEL: "",
      NOELLE_CODEX_CLI_PATH: undefined,
      NOELLE_CODEX_CLI_TIMEOUT_MS: "",
    })).toEqual({});
  });
});

import { describe, expect, it } from "vitest";
import { buildCodexCliArgv, parseCodexUsage, parseCodexError } from "./codexCliBackend.js";

describe("buildCodexCliArgv", () => {
  it("sets the requested reasoning effort for quality-sensitive calls", () => {
    const argv = buildCodexCliArgv("/tmp/answer.txt", "gpt-5.6-sol", "high");
    expect(argv).toContain("model_reasoning_effort=\"high\"");
  });
});

describe("parseCodexUsage", () => {
  it("reads usage off turn.completed", () => {
    const out = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"turn.started"}',
      '{"type":"turn.completed","usage":{"input_tokens":12083,"cached_input_tokens":3456,"output_tokens":19,"reasoning_output_tokens":11}}',
    ].join("\n");
    expect(parseCodexUsage(out)).toEqual({ input_tokens: 12083, output_tokens: 19 });
  });

  it("does NOT add cached_input_tokens on top of input_tokens", () => {
    // Codex reports cached tokens as a SUBSET of input_tokens, unlike
    // Anthropic's cache fields which are additive. Summing them would
    // overstate every call and push the budget cap over early.
    const out =
      '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":900,"output_tokens":5}}';
    expect(parseCodexUsage(out).input_tokens).toBe(1000);
  });

  it("does NOT add reasoning_output_tokens on top of output_tokens", () => {
    const out =
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":60,"reasoning_output_tokens":51}}';
    expect(parseCodexUsage(out).output_tokens).toBe(60);
  });

  it("keeps absent usage unreported with safe numeric storage values", () => {
    expect(parseCodexUsage('{"type":"turn.started"}\nnot json\n')).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      token_usage_reported: false,
    });
  });
});

describe("parseCodexError", () => {
  it("unwraps the API message Codex nests inside a string", () => {
    // The real shape from a ChatGPT account rejecting a model. stderr was
    // EMPTY for this — the reason only exists on stdout, so a bare exit code
    // would tell the operator nothing.
    const out =
      '{"type":"turn.started"}\n' +
      '{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'gpt-5-codex\' model is not supported when using Codex with a ChatGPT account.\\"}}"}';
    expect(parseCodexError(out)).toBe(
      "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it("falls back to the raw message when it is not nested JSON", () => {
    expect(parseCodexError('{"type":"turn.failed","error":{"message":"boom"}}')).toBe("boom");
  });

  it("returns null on a clean run", () => {
    expect(parseCodexError('{"type":"turn.completed","usage":{"input_tokens":1}}')).toBeNull();
  });
});

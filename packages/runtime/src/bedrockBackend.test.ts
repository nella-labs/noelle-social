import { describe, expect, it, vi } from "vitest";
import {
  createBedrockBackend,
  BedrockAuthError,
  BedrockError,
  type CreateBedrockBackendOptions,
} from "./bedrockBackend.js";

type ClientImpl = NonNullable<CreateBedrockBackendOptions["clientImpl"]>;

function makeMockClient(
  impl: (args: {
    model: string;
    max_tokens: number;
    system: string;
    messages: { role: string; content: string }[];
  }) => Promise<unknown> | unknown,
) {
  // The real SDK has many methods; we only exercise `messages.create`.
  return {
    messages: {
      create: (args: unknown) => Promise.resolve(impl(args as never)),
    },
  } as unknown as ClientImpl;
}

describe("createBedrockBackend", () => {
  it("fails closed when native process-group cleanup is unsupported", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    try {
      await expect(createBedrockBackend({ mock: false }).call({ system: "", prompt: "fixture", model: "fixture" }))
        .rejects.toThrow("unsupported_platform");
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([0, -1, 1.5, NaN, Infinity, 1_800_001])("rejects invalid call deadline %s before client I/O", async timeoutMs => {
    const create = vi.fn(() => ({ content: [], usage: {} }));
    const backend = createBedrockBackend({ clientImpl: makeMockClient(create) });
    await expect(backend.call({ system: "", prompt: "fixture", model: "fixture", timeoutMs })).rejects.toThrow("invalid_request");
    expect(create).not.toHaveBeenCalled();
  });
  it("does not restart the original deadline for cache fallback", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const create = vi.fn(async () => {
      await vi.advanceTimersByTimeAsync(50);
      throw new Error("cache_control unsupported");
    });
    try {
      const backend = createBedrockBackend({ clientImpl: makeMockClient(create), timeoutMs: 50 });
      await expect(backend.call({ system: "fixture", prompt: "fixture", model: "fixture", cacheSystem: true })).rejects.toThrow("timeout");
      expect(create).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("keeps provider error content out of the public error", async () => {
    const client = makeMockClient(() => { throw new Error("fixture-secret fixture-prompt"); });
    await expect(createBedrockBackend({ clientImpl: client }).call({ system: "", prompt: "fixture", model: "fixture" }))
      .rejects.toThrow(/^bedrock call: failed$/);
  });
  it.each([403, 429, 500])("never retries a status%s error that mentions cache", async status => {
    const create = vi.fn(() => { throw Object.assign(new Error("cache fixture-secret"), { status }); });
    const backend = createBedrockBackend({ clientImpl: makeMockClient(create) });
    await expect(backend.call({ system: "fixture", prompt: "fixture", model: "fixture", cacheSystem: true }))
      .rejects.toMatchObject({ status });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("maps abstract model names to AWS Bedrock model IDs and returns text+usage", async () => {
    let received: { model?: string; system?: string; messages?: unknown } | null = null;
    const client = makeMockClient((args) => {
      received = args;
      return {
        content: [{ type: "text", text: "hello world" }],
        usage: { input_tokens: 42, output_tokens: 11 },
      };
    });
    const be = createBedrockBackend({ clientImpl: client! });
    const res = await be.call({
      system: "you are a writer",
      prompt: "draft a tweet",
      model: "claude-sonnet-4-6",
    });
    expect(res.text).toBe("hello world");
    expect(res.usage).toEqual({ input_tokens: 42, output_tokens: 11 });
    // Default maps the abstract Sonnet name to the Sonnet 4.6 inference
    // profile. Override via env or `modelIds` opt for other models.
    expect(received!.model).toBe("us.anthropic.claude-sonnet-4-6");
    expect(received!.system).toBe("you are a writer");
  });

  it("prepends conversation history before the new user prompt", async () => {
    let received: { messages?: { role: string; content: string }[] } | null = null;
    const client = makeMockClient((args) => {
      received = args;
      return { content: [{ type: "text", text: "ok" }], usage: {} };
    });
    const be = createBedrockBackend({ clientImpl: client! });
    await be.call({
      system: "sys",
      prompt: "and now?",
      model: "claude-sonnet-4-6",
      history: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hey, what's up?" },
      ],
    });
    // History first (oldest → newest), then the new user prompt last, so the
    // sequence alternates user/assistant/user as Anthropic requires.
    expect(received!.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey, what's up?" },
      { role: "user", content: "and now?" },
    ]);
  });

  it("sends just the prompt when no history is provided", async () => {
    let received: { messages?: { role: string; content: string }[] } | null = null;
    const client = makeMockClient((args) => {
      received = args;
      return { content: [{ type: "text", text: "ok" }], usage: {} };
    });
    const be = createBedrockBackend({ clientImpl: client! });
    await be.call({ system: "", prompt: "solo", model: "claude-sonnet-4-6" });
    expect(received!.messages).toEqual([{ role: "user", content: "solo" }]);
  });

  it("honors per-instance modelIds override", async () => {
    let received: { model?: string } | null = null;
    const client = makeMockClient((args) => {
      received = args;
      return { content: [{ type: "text", text: "ok" }], usage: {} };
    });
    const be = createBedrockBackend({
      clientImpl: client!,
      modelIds: { "claude-sonnet-4-6": "anthropic.claude-3-5-sonnet-20241022-v2:0" },
    });
    await be.call({ system: "", prompt: "x", model: "claude-sonnet-4-6" });
    expect(received!.model).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
  });

  it("passes through unknown model names verbatim (visible failure mode)", async () => {
    let received: { model?: string } | null = null;
    const client = makeMockClient((args) => {
      received = args;
      return { content: [{ type: "text", text: "" }], usage: {} };
    });
    const be = createBedrockBackend({ clientImpl: client! });
    await be.call({ system: "", prompt: "", model: "some.aws.id.directly:1" });
    expect(received!.model).toBe("some.aws.id.directly:1");
  });

  it("wraps 401/403 SDK errors as BedrockAuthError", async () => {
    const client = makeMockClient(() => {
      const e = new Error("invalid credentials") as Error & { status: number };
      e.status = 403;
      throw e;
    });
    const be = createBedrockBackend({ clientImpl: client! });
    await expect(
      be.call({ system: "", prompt: "x", model: "claude-sonnet-4-6" }),
    ).rejects.toBeInstanceOf(BedrockAuthError);
  });

  it("wraps non-auth SDK errors as BedrockError", async () => {
    const client = makeMockClient(() => {
      const e = new Error("rate limit") as Error & { status: number };
      e.status = 429;
      throw e;
    });
    const be = createBedrockBackend({ clientImpl: client! });
    const p = be.call({ system: "", prompt: "x", model: "claude-sonnet-4-6" });
    await expect(p).rejects.toBeInstanceOf(BedrockError);
    await expect(p).rejects.not.toBeInstanceOf(BedrockAuthError);
  });

  it("mock mode short-circuits without calling the client", async () => {
    let called = false;
    const client = makeMockClient(() => {
      called = true;
      return { content: [], usage: {} };
    });
    const be = createBedrockBackend({ clientImpl: client!, mock: true });
    const res = await be.call({ system: "", prompt: "abc", model: "claude-sonnet-4-6" });
    expect(called).toBe(false);
    expect(res.text).toMatch(/bedrock-mock/);
  });

  // ---- Prompt caching (PR-E) --------------------------------------------
  it("sends a plain-string system when no caching arg is set (byte-identical to today)", async () => {
    let received: { system?: unknown } | null = null;
    const client = makeMockClient((args) => {
      received = args;
      return { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, output_tokens: 2 } };
    });
    const be = createBedrockBackend({ clientImpl: client! });
    await be.call({ system: "you are a writer", prompt: "hi", model: "claude-sonnet-4-6" });
    expect(typeof received!.system).toBe("string");
    expect(received!.system).toBe("you are a writer");
  });

  it("attaches a whole-system ephemeral breakpoint when cacheSystem is set", async () => {
    let received: { system?: unknown } | null = null;
    const client = makeMockClient((args) => {

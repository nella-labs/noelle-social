import { describe, expect, it, vi } from "vitest";
import {
  createAnthropicBackend,
  AnthropicAuthError,
  AnthropicError,
  type CreateAnthropicBackendOptions,
} from "./anthropicBackend.js";

type ClientImpl = NonNullable<CreateAnthropicBackendOptions["clientImpl"]>;

function makeMockClient(
  impl: (args: {
    model: string;
    max_tokens: number;
    system: string;
    messages: { role: string; content: string }[];
  }) => Promise<unknown> | unknown,
) {
  return {
    messages: {
      create: (args: unknown) => Promise.resolve(impl(args as never)),
    },
  } as unknown as ClientImpl;
}

describe("createAnthropicBackend", () => {
  it.each([403, 429, 500])("does not replay a status%s error that mentions cache", async status => {
    const create = vi.fn(() => { throw Object.assign(new Error("cache failure"), { status }); });
    const backend = createAnthropicBackend({ clientImpl: makeMockClient(create) });
    await expect(backend.call({ system: "fixture", prompt: "fixture", model: "fixture", cacheSystem: true }))
      .rejects.toMatchObject({ status });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("maps abstract model names to Anthropic ids and returns text+usage", async () => {
    let received: { model?: string; system?: string } | null = null;
    const client = makeMockClient((args) => {
      received = args;
      return {
        content: [{ type: "text", text: "hello world" }],
        usage: { input_tokens: 42, output_tokens: 11 },
      };
    });
    const be = createAnthropicBackend({ clientImpl: client });
    const res = await be.call({
      system: "you are a writer",
      prompt: "draft a tweet",
      model: "claude-sonnet-4-6",
    });
    expect(res.text).toBe("hello world");
    expect(res.usage).toEqual({ input_tokens: 42, output_tokens: 11 });
    expect(received!.model).toBe("claude-sonnet-4-6");
    expect(received!.system).toBe("you are a writer");
  });

  it("honors per-instance modelIds override", async () => {
    let received: { model?: string } | null = null;
    const client = makeMockClient((args) => {
      received = args;
      return { content: [{ type: "text", text: "ok" }], usage: {} };
    });
    const be = createAnthropicBackend({
      clientImpl: client,
      modelIds: { "claude-sonnet-4-6": "claude-sonnet-4-6-20990101" },
    });
    await be.call({ system: "", prompt: "x", model: "claude-sonnet-4-6" });
    expect(received!.model).toBe("claude-sonnet-4-6-20990101");
  });

  it("wraps 401/403 SDK errors as AnthropicAuthError", async () => {
    const client = makeMockClient(() => {
      const e = new Error("invalid x-api-key") as Error & { status: number };
      e.status = 401;
      throw e;
    });
    const be = createAnthropicBackend({ clientImpl: client });
    await expect(
      be.call({ system: "", prompt: "x", model: "claude-sonnet-4-6" }),
    ).rejects.toBeInstanceOf(AnthropicAuthError);
  });

  it("wraps non-auth SDK errors as AnthropicError", async () => {
    const client = makeMockClient(() => {
      const e = new Error("overloaded") as Error & { status: number };
      e.status = 529;
      throw e;
    });
    const be = createAnthropicBackend({ clientImpl: client });
    const p = be.call({ system: "", prompt: "x", model: "claude-sonnet-4-6" });
    await expect(p).rejects.toBeInstanceOf(AnthropicError);
    await expect(p).rejects.not.toBeInstanceOf(AnthropicAuthError);
  });

  it("mock mode short-circuits without calling the client", async () => {
    let called = false;
    const client = makeMockClient(() => {
      called = true;
      return { content: [], usage: {} };
    });
    const be = createAnthropicBackend({ clientImpl: client, mock: true });
    const res = await be.call({ system: "", prompt: "abc", model: "claude-sonnet-4-6" });
    expect(called).toBe(false);
    expect(res.text).toMatch(/anthropic-mock/);
  });
});

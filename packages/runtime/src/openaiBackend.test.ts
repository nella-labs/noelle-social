import { describe, expect, it } from "vitest";
import {
  createOpenAiBackend,
  OpenAiAuthError,
  OpenAiError,
  type CreateOpenAiBackendOptions,
} from "./openaiBackend.js";

type ClientImpl = NonNullable<CreateOpenAiBackendOptions["clientImpl"]>;

function makeMockClient(
  impl: (args: {
    model: string;
    max_completion_tokens: number;
    messages: { role: string; content: string }[];
  }) => Promise<unknown> | unknown,
) {
  return {
    chat: {
      completions: {
        create: (args: unknown) => Promise.resolve(impl(args as never)),
      },
    },
  } as unknown as ClientImpl;
}

describe("createOpenAiBackend", () => {
  it("sends system+user messages and returns text+usage", async () => {
    let received: { model?: string; messages?: { role: string; content: string }[] } | null = null;
    const client = makeMockClient((args) => {
      received = args;
      return {
        choices: [{ message: { content: "drafted" } }],
        usage: { prompt_tokens: 30, completion_tokens: 9 },
      };
    });
    const be = createOpenAiBackend({ clientImpl: client });
    const res = await be.call({
      system: "you are a writer",
      prompt: "draft a tweet",
      model: "gpt-5",
    });
    expect(res.text).toBe("drafted");
    expect(res.usage).toEqual({ input_tokens: 30, output_tokens: 9 });
    expect(received!.model).toBe("gpt-5");
    expect(received!.messages?.[0]).toEqual({ role: "system", content: "you are a writer" });
    expect(received!.messages?.[1]).toEqual({ role: "user", content: "draft a tweet" });
  });

  it("honors per-instance modelIds override", async () => {
    let received: { model?: string } | null = null;
    const client = makeMockClient((args) => {
      received = args;
      return { choices: [{ message: { content: "" } }], usage: {} };
    });
    const be = createOpenAiBackend({
      clientImpl: client,
      modelIds: { "gpt-5": "gpt-5-2026-01-01" },
    });
    await be.call({ system: "", prompt: "x", model: "gpt-5" });
    expect(received!.model).toBe("gpt-5-2026-01-01");
  });

  it("wraps 401 SDK errors as OpenAiAuthError", async () => {
    const client = makeMockClient(() => {
      const e = new Error("Incorrect API key") as Error & { status: number };
      e.status = 401;
      throw e;
    });
    const be = createOpenAiBackend({ clientImpl: client });
    await expect(
      be.call({ system: "", prompt: "x", model: "gpt-5" }),
    ).rejects.toBeInstanceOf(OpenAiAuthError);
  });

  it("wraps non-auth SDK errors as OpenAiError", async () => {
    const client = makeMockClient(() => {
      const e = new Error("rate limit") as Error & { status: number };
      e.status = 429;
      throw e;
    });
    const be = createOpenAiBackend({ clientImpl: client });
    const p = be.call({ system: "", prompt: "x", model: "gpt-5" });
    await expect(p).rejects.toBeInstanceOf(OpenAiError);
    await expect(p).rejects.not.toBeInstanceOf(OpenAiAuthError);
  });

  it("mock mode short-circuits without calling the client", async () => {
    let called = false;
    const client = makeMockClient(() => {
      called = true;
      return { choices: [], usage: {} };
    });
    const be = createOpenAiBackend({ clientImpl: client, mock: true });
    const res = await be.call({ system: "", prompt: "abc", model: "gpt-5-mini" });
    expect(called).toBe(false);
    expect(res.text).toMatch(/openai-mock/);
  });
});

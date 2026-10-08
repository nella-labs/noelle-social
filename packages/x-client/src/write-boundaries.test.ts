import { describe, expect, it, vi } from "vitest";
import { createXApiClient, XWriteUncertainError } from "./index.js";

const allowed = { role: "x_intern", sendEnabled: true, xApiWriteEnabled: true, tokens: { accessToken: "fixture" } };
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

describe("official write outcome boundaries", () => {
  it("never retries a dispatched request whose response is lost", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection reset"));
    const client = createXApiClient({ ...allowed, fetchFn });
    await expect(client.postTweet({ text: "A supported observation." })).rejects.toBeInstanceOf(XWriteUncertainError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { data: { id: "" } }, { data: { id: 123 } }, { data: { id: "not-a-post-id" } }, { data: { id: "0" } }, { data: { id: "9".repeat(26) } }])("never returns a fabricated success receipt for %j", async body => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(201, body));
    const client = createXApiClient({ ...allowed, fetchFn });
    await expect(client.postTweet({ text: "A supported observation." })).rejects.toBeInstanceOf(XWriteUncertainError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("holds a dispatched write after a server error", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(503, {}));
    const client = createXApiClient({ ...allowed, fetchFn });
    await expect(client.postTweet({ text: "A supported observation." })).rejects.toBeInstanceOf(XWriteUncertainError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("keeps malformed successful response bodies uncertain", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("broken", { status: 201 }));
    const client = createXApiClient({ ...allowed, fetchFn });
    await expect(client.postTweet({ text: "A supported observation." })).rejects.toBeInstanceOf(XWriteUncertainError);
  });
});

describe("official request deadlines", () => {
  it("aborts a stalled read instead of occupying a worker indefinitely", async () => {
    const fetchFn = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const client = createXApiClient({ ...allowed, fetchFn, requestTimeoutMs: 25 });
    await expect(client.getMyAccount()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("treats an aborted dispatched post as uncertain and never retries it", async () => {
    const fetchFn = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const client = createXApiClient({ ...allowed, fetchFn, requestTimeoutMs: 25 });
    await expect(client.postTweet({ text: "A supported observation." })).rejects.toBeInstanceOf(XWriteUncertainError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

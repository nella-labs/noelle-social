import { pngImageBytes } from "../imageBytes.fixture.js";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { describe, expect, it, vi } from "vitest";
import { captionImages, createBedrockCaptionFn, createGeminiCaptionFn, createVertexCaptionFn, type BedrockVisionClient } from "./visionCaption.js";

const image = () => new Response(pngImageBytes());
const generation = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "caption" }] } }] }));
function delayed(body: string) {
  let canceled = false;
  let timer: ReturnType<typeof setTimeout>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
    timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode(body)); controller.close(); }, 150);
  }, cancel() { canceled = true; clearTimeout(timer); } }));
  return { response, canceled: () => canceled };
}

describe("vision HTTP bounds", () => {
  it("bounds image response bodies before a paid generation request", async () => {
    const slow = delayed("image bytes");
    const fetchImpl = vi.fn().mockResolvedValueOnce(slow.response).mockResolvedValueOnce(generation());
    const options = { apiKey: "test", timeoutMs: 20, fetchImpl };
    await expect(createGeminiCaptionFn(options)(["https://example.test/image.jpg"], {})).rejects.toThrow(/timed out/);
    expect(slow.canceled()).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized image before generation", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array(5 * 1024 * 1024 + 1)))
      .mockResolvedValueOnce(generation());
    await expect(createGeminiCaptionFn({ apiKey: "test", fetchImpl })(["https://example.test/image.jpg"], {}))
      .rejects.toThrow(/byte limit/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["key", "vertex"] as const)("bounds %s generation bodies after image download", async (kind) => {
    const slow = delayed(JSON.stringify({ candidates: [{ content: { parts: [{ text: "late" }] } }] }));
    const fetchImpl = vi.fn().mockResolvedValueOnce(image()).mockResolvedValueOnce(slow.response);
    const options = { apiKey: "test", project: "test", timeoutMs: 20, fetchImpl,
      authClient: { getAccessToken: async () => "test" } };
    const factory = kind === "key" ? createGeminiCaptionFn(options) : createVertexCaptionFn(options);
    await expect(factory(["https://example.test/image.jpg"], {})).rejects.toThrow(/timed out/);
    expect(slow.canceled()).toBe(true);
  });

  it.each(["key", "vertex"] as const)("does not convert malformed %s output into a caption", async (kind) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(image()).mockResolvedValueOnce(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: { private: "invalid" } }] } }],
    })));
    const options = { apiKey: "test", project: "test", fetchImpl, authClient: { getAccessToken: async () => "test" } };
    const captionFn = kind === "key" ? createGeminiCaptionFn(options) : createVertexCaptionFn(options);
    expect(await captionImages({ imageUrls: ["https://example.test/image.jpg"], captionFn })).toBe("");
  });

  it("caps direct factory image downloads to three", async () => {
    const fetchImpl = vi.fn(async (url) => String(url).includes("generateContent") ? generation() : image());
    await createGeminiCaptionFn({ apiKey: "test", fetchImpl })(Array.from({ length: 4 }, (_, i) => `https://example.test/${i}.jpg`), {});
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("cancels actual Bedrock SDK body I/O using its supported request signal", async () => {
    let admit!: () => void, receive!: () => void, close!: () => void;
    let requests = 0, bodyClosed = false;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    const received = new Promise<void>(resolve => { receive = resolve; });
    const socketClosed = new Promise<void>(resolve => { close = resolve; });
    const sockets = new Set<Socket>();
    const socketTails: Promise<void>[] = [];
    let requestSocket: Socket | undefined;
    const server = createServer((req, response) => {
      requests++;
      req.resume();
      requestSocket = req.socket;
      req.socket.once("close", close);
      response.once("close", () => { bodyClosed = true; });
      response.writeHead(200, { "content-type": "application/json" });
      response.write(" ");
      admit();
    });
    server.on("connection", socket => {
      sockets.add(socket);
      socketTails.push(new Promise<void>(resolve => {
        socket.once("close", () => { sockets.delete(socket); resolve(); });
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const cleanup = new AbortController();
    const guard = delay(2000, undefined, { signal: cleanup.signal }).then(() => {
      throw new Error("native caption fixture admission or close timed out");
    });
    let pending: Promise<string> | undefined, settled = false;
    try {
      const client = new AnthropicBedrock({ awsRegion: "us-east-1", skipAuth: true, maxRetries: 0,
        fetch: async (_url, init) => {
          const response = await fetch(`http://127.0.0.1:${address.port}`, init);
          receive();
          return response;
        } });
      const options = { clientImpl: client.messages as unknown as BedrockVisionClient, fetchImpl: async () => image(), timeoutMs: 20 };
      const captionFn = createBedrockCaptionFn(options);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      pending = captionImages({ imageUrls: ["https://example.test/image.jpg"], captionFn })
        .then(result => { settled = true; return result; });
      await Promise.race([Promise.all([admitted, received]), guard]);
      expect(requests).toBe(1);
      expect(bodyClosed).toBe(false);
      expect(sockets.size).toBe(1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      expect(await Promise.race([pending, guard])).toBe("");
      await Promise.race([socketClosed, guard]);
      expect(bodyClosed).toBe(true);
      expect(requestSocket?.destroyed).toBe(true);
      expect(requests).toBe(1);
    } finally {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(20);
      vi.useRealTimers();
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await serverClosed;
      await Promise.all(socketTails);
      await pending;
      cleanup.abort();
      await guard.catch(() => {});
      expect(sockets.size).toBe(0);
    }
  });
});

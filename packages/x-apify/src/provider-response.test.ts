import { afterEach, describe, expect, it, vi } from "vitest";
import { checkApifyToken, createApifyXClient } from "./index.js";

const oversized = () => "x".repeat(4 * 1024 * 1024 + 1);
const run = () =>
  Response.json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } });
afterEach(() => vi.useRealTimers());

describe("bounded provider responses", () => {
  it("keeps the actor deadline active while metadata body is stalled", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cancel = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; controller.enqueue(new TextEncoder().encode("{")); },
      cancel,
    })));
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = createApifyXClient({ token: "fixture", fetchImpl, timeoutMs: 20 })
        .userTweets({ handle: "builder" });
      const guarded = Promise.race([request, new Promise((_, reject) => {
        guard = setTimeout(() => reject(new Error("body deadline missed")), 150);
      })]);
      await expect(guarded).rejects.toMatchObject({ status: 0, message: expect.stringContaining("timed out") });
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      clearTimeout(guard);
      streamController?.error(new Error("fixture ended"));
    }
  });

  it("rejects oversized actor metadata before downloading a dataset", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        Response.json({ data: { id: "run", status: "SUCCEEDED", padding: oversized() } }),
      );
    await expect(
      createApifyXClient({ token: "test", fetchImpl }).userTweets({ handle: "builder" }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["start", "dataset"])("bounds oversized %s error bodies", async (stage) => {
    const fetchImpl = vi.fn();
    if (stage === "dataset") fetchImpl.mockResolvedValueOnce(run());
    fetchImpl.mockResolvedValue(new Response(oversized(), { status: 500 }));
    await expect(
      createApifyXClient({ token: "test", fetchImpl }).userTweets({ handle: "builder" }),
    ).rejects.toMatchObject({ status: 500, message: expect.stringContaining("4 MiB") });
  });

  it("bounds polled metadata through the same decoder", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { id: "run", status: "RUNNING" } }))
      .mockResolvedValue(
        Response.json({ data: { id: "run", status: "SUCCEEDED", padding: oversized() } }),
      );
    const outcome = createApifyXClient({ token: "test", fetchImpl })
      .userTweets({ handle: "builder" })
      .catch((error: { status: number }) => error.status);
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports oversized successful health metadata as an inconclusive check", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ data: { padding: oversized() } }));
    expect(await checkApifyToken("test", { fetchImpl })).toMatchObject({
      alive: false,
      httpStatus: 200,
    });
  });

  it("bounds health error bodies while preserving the confirmed HTTP status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(oversized(), { status: 401 }));
    const health = await checkApifyToken("test", { fetchImpl });
    expect(health).toMatchObject({ alive: false, httpStatus: 401 });
    expect(health.error).toMatch(/4 MiB/);
    expect(health.error?.length).toBeLessThan(200);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createApifyTransport } from "./apifyTransport.js";

class DomainError extends Error { constructor(message: string, readonly status: number) { super(message); } }
const run = (status = "SUCCEEDED", usageTotalUsd: unknown = 0.37) =>
  Response.json({ data: { id: "run", status, defaultDatasetId: "data", usageTotalUsd } });
function transport(fetchImpl: typeof fetch, timeoutMs = 1000) {
  return createApifyTransport({ token: "private-fixture-token", fetchImpl, timeoutMs,
    errorFactory: (message, status) => new DomainError(message, status) });
}
const request = { actorId: "publisher~actor", actor: "actor", input: { maxItems: 2 }, itemLimit: 2 };

describe("canonical Apify transport", () => {
  it("does not dispatch a dataset after the operation deadline, while retaining its terminal charge", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchImpl = vi.fn().mockImplementationOnce(async () => { now = 1001; return run(); })
      .mockResolvedValueOnce(Response.json([]));
    const client = transport(fetchImpl);
    try {
      await expect(client.runActor(request)).rejects.toMatchObject({ status: 0, message: expect.stringContaining("timed out") });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(client.drainRunReceipts()[0]).toMatchObject({ runId: "run", terminal: true, actualUsd: 0.37 });
    } finally { clock.mockRestore(); }
  });

  it("rejects a poll response for another run without adopting its charge or dataset", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValueOnce(run("RUNNING"))
      .mockResolvedValueOnce(Response.json({ data: { id: "other", status: "SUCCEEDED", defaultDatasetId: "foreign", usageTotalUsd: 9 } }))
      .mockResolvedValueOnce(Response.json([]));
    const client = transport(fetchImpl, 3000);
    try {
      const result = client.runActor(request).then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toMatchObject({ error: { status: 502, message: expect.stringContaining("identity") } });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(client.drainRunReceipts()[0]).toMatchObject({ runId: "run", status: "RUNNING", terminal: false, actualUsd: null });
    } finally { vi.useRealTimers(); }
  });

  it("preserves an explicit ten-minute operation deadline through the shared HTTP ceiling", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(run()).mockResolvedValueOnce(Response.json([]));
    await expect(transport(fetchImpl, 600_000).runActor(request)).resolves.toMatchObject({ items: [] });
  });

  it("caps the dataset request and retains exact provider total before normalization", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(run()).mockResolvedValueOnce(
      Response.json([{ id: 1 }, { id: 2 }, { id: 3 }], { headers: { "X-Apify-Pagination-Total": "999" } }));
    const client = transport(fetchImpl);
    expect(await client.runActor(request)).toEqual({ items: [{ id: 1 }, { id: 2 }],
      resultCount: 999, fetchedResultCount: 3, resultCountComplete: true });
    expect(new URL(String(fetchImpl.mock.calls[1]![0])).searchParams.get("limit")).toBe("2");
    expect(client.drainRunReceipts()[0]).toMatchObject({ actualUsd: 0.37, resultCount: 999 });
  });

  it.each([null, "", "2.5", "9007199254740992", "0"])("keeps unconfirmed total %j incomplete", async total => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(run()).mockResolvedValueOnce(
      Response.json([{}], { headers: total === null ? {} : { "X-Apify-Pagination-Total": total } }));
    const client = transport(fetchImpl);
    expect(await client.runActor(request)).toMatchObject({ resultCount: 1, fetchedResultCount: 1, resultCountComplete: false });
  });

  it.each(["FAILED", "ABORTED", "TIMED-OUT"])("retains terminal %s usage without fetching a dataset", async status => {
    const fetchImpl = vi.fn().mockResolvedValue(run(status));
    const client = transport(fetchImpl);
    await expect(client.runActor(request)).rejects.toBeInstanceOf(DomainError);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(client.drainRunReceipts()[0]).toMatchObject({ status, terminal: true, actualUsd: 0.37 });
  });

  it("retains a successful run charge when its dataset fails, then clears it for another operation", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(run()).mockResolvedValueOnce(new Response("secret token", { status: 403 }));
    const client = transport(fetchImpl);
    await expect(client.runActor(request)).rejects.toMatchObject({ status: 403, message: expect.not.stringContaining("secret") });
    expect(client.drainLastRunUsd()).toBe(0.37);
    expect(client.drainRunReceipts()[0]?.actualUsd).toBe(0.37);
    client.beginOperation();
    expect(client.drainRunReceipts()).toEqual([]);
  });

  it("preserves fatal HTTP status even when its error body exceeds the bound", async () => {
    const client = transport(vi.fn().mockResolvedValue(new Response("x".repeat(4 * 1024 * 1024 + 1), { status: 401 })));
    await expect(client.runActor(request)).rejects.toMatchObject({ status: 401, message: expect.stringContaining("4 MiB") });
  });

  it("preserves confirmed fatal HTTP status when its body stalls until the deadline", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 401 }));
    await expect(transport(fetchImpl, 20).runActor(request)).rejects.toMatchObject({ status: 401 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([NaN, Infinity, -1, 1.5, 5001])("rejects invalid item limit %s before a paid call", async itemLimit => {
    const fetchImpl = vi.fn();
    await expect(transport(fetchImpl).runActor({ ...request, itemLimit })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces the receipt run bound before starting another paid run", async () => {
    const fetchImpl = vi.fn(async (_url, init?: RequestInit) => init?.method === "POST" ? run() : Response.json([]));
    const client = transport(fetchImpl);
    for (let index = 0; index < 64; index++) await client.runActor(request);
    await expect(client.runActor(request)).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(128);
    expect(client.drainRunReceipts()).toHaveLength(64);
  });
});

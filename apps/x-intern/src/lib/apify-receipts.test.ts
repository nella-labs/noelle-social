import { describe, expect, it, vi } from "vitest";
import { createApifyXClient } from "@noelle/x-apify";
import { createRotatingApifyClient } from "./apify-rotating.js";
import { withMeteredApifyCall } from "./apify-receipts.js";

const context = () => ({
  orgId: "org",
  instanceId: "instance",
  worker: "discovery",
  agentRole: "x_intern" as const,
  actor: "twitter-x-data-tweet-scraper",
  startedAt: new Date(),
  credentialId: "primary",
  recorder: { record: vi.fn().mockResolvedValue(undefined) },
  log: { warn: vi.fn() },
});
function pool(firstStatus: number, second = false, usage: number | null = 0.2) {
  return createRotatingApifyClient({
    candidates: ["first", ...(second ? ["second"] : [])].map((token) => ({
      credentialId: token,
      token,
      wasExhausted: false,
    })),
    buildClient: (token) =>
      createApifyXClient({
        token,
        fetchImpl: (async (_url: unknown, init?: RequestInit) => {
          if (init?.method === "POST")
            return Response.json({
              data: {
                id: token,
                status: "SUCCEEDED",
                defaultDatasetId: token,
                usageTotalUsd: token === "first" ? usage : 0.3,
              },
            });
          return token === "first" && firstStatus !== 200
            ? new Response("failed", { status: firstStatus })
            : Response.json([], { headers: { "X-Apify-Pagination-Total": "0" } });
        }) as typeof fetch,
      }),
  });
}

describe("receipt-owned metering", () => {
  it("meters overlapping operations independently without clearing another run's receipt", async () => {
    let releaseFirstDataset!: () => void;
    let releaseSecondMetadata!: () => void;
    let firstDatasetStarted!: () => void;
    let secondMetadataStarted!: () => void;
    const firstDataset = new Promise<void>(resolve => { releaseFirstDataset = resolve; });
    const secondMetadata = new Promise<void>(resolve => { releaseSecondMetadata = resolve; });
    const datasetStarted = new Promise<void>(resolve => { firstDatasetStarted = resolve; });
    const metadataStarted = new Promise<void>(resolve => { secondMetadataStarted = resolve; });
    let posts = 0;
    const client = createRotatingApifyClient({
      candidates: [{ credentialId: "shared-token", token: "token", wasExhausted: false }],
      buildClient: token => createApifyXClient({ token,
        fetchImpl: (async (url: unknown, init?: RequestInit) => {
          if (init?.method === "POST") {
            const run = ++posts;
            if (run === 2) { secondMetadataStarted(); await secondMetadata; }
            return Response.json({ data: { id: String(run), status: "SUCCEEDED",
              defaultDatasetId: String(run), usageTotalUsd: run === 1 ? 0.2 : 0.3 } });
          }
          if (String(url).includes("/datasets/1/")) { firstDatasetStarted(); await firstDataset; }
          return Response.json([], { headers: { "X-Apify-Pagination-Total": "0" } });
        }) as typeof fetch,
      }),
    });
    const args = context();
    const first = withMeteredApifyCall({ ...args, client }, operation => operation.userTweets({ handle: "first" }));
    await datasetStarted;
    const second = withMeteredApifyCall({ ...args, client }, operation => operation.userTweets({ handle: "second" }));
    await metadataStarted;
    releaseFirstDataset(); await first;
    releaseSecondMetadata(); await second;
    expect(args.recorder.record.mock.calls.map(([row]) => [row.credentialId, row.cents])).toEqual([
      ["shared-token", 20], ["shared-token", 30],
    ]);
    expect(client.drainRunReceipts?.()).toEqual([]);
  });

  it("records a paid dataset failure before preserving the original error", async () => {
    const client = pool(500),
      args = context();
    await expect(
      withMeteredApifyCall({ ...args, client }, operation => operation.userTweets({ handle: "builder" })),
    ).rejects.toMatchObject({ status: 500 });
    expect(args.recorder.record).toHaveBeenCalledOnce();
    expect(args.recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({ cents: 20, credentialId: "first" }),
    );
  });

  it("records both real paid failover charges with each attempted credential", async () => {
    const client = pool(401, true),
      args = context();
    await withMeteredApifyCall({ ...args, client }, operation => operation.userTweets({ handle: "builder" }));
    expect(
      args.recorder.record.mock.calls.map(([row]) => ({
        cents: row.cents,
        credentialId: row.credentialId,
      })),
    ).toEqual([
      { cents: 20, credentialId: "first" },
      { cents: 30, credentialId: "second" },
    ]);
  });

  it("records normal success once and drains compatibility state", async () => {
    const client = pool(200),
      args = context();
    await withMeteredApifyCall({ ...args, client }, operation => operation.userTweets({ handle: "builder" }));
    expect(args.recorder.record).toHaveBeenCalledOnce();
    expect(client.drainLastRunUsd()).toBeNull();
    expect(client.drainRunReceipts?.()).toEqual([]);
    await withMeteredApifyCall({ ...args, client }, operation =>
      operation.userTweets({ handle: "builder", limit: 0 }),
    );
    expect(args.recorder.record).toHaveBeenCalledOnce();
  });

  it("warns rather than estimating missing usage after a paid dataset failure", async () => {
    const client = pool(500, false, null),
      args = context();
    await withMeteredApifyCall({ ...args, client }, operation =>
      operation.userTweets({ handle: "builder" }),
    ).catch(() => {});
    expect(args.recorder.record).not.toHaveBeenCalled();
    expect(args.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ worker: "discovery" }),
      expect.stringContaining("spend unknown"),
    );
  });

  it("retains legacy successful count estimation", async () => {
    const args = context();
    await withMeteredApifyCall({ ...args, client: {} }, async () => ({
      tweets: [],
      resultCount: 100,
    }));
    expect(args.recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({ cents: 3, credentialId: "primary" }),
    );
  });

  it("preserves the retrieval error when recording throws synchronously", async () => {
    const client = pool(500),
      args = context();
    args.recorder.record.mockImplementation(() => {
      throw new Error("private storage error");
    });
    await expect(
      withMeteredApifyCall({ ...args, client }, operation => operation.userTweets({ handle: "builder" })),
    ).rejects.toMatchObject({ status: 500 });
    expect(args.log.warn).toHaveBeenCalledWith(
      { worker: "discovery", actor: "twitter-x-data-tweet-scraper" },
      "Apify spend could not be recorded",
    );
  });
});

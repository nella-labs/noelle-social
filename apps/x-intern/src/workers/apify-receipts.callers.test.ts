import { describe, expect, it, vi } from "vitest";
import { createApifyXClient } from "@noelle/x-apify";
import { createRotatingApifyClient } from "../lib/apify-rotating.js";
import { runDiscoveryTick } from "./discovery-tick.js";
import { runProfilerTick } from "./profiler-tick.js";
import { runAccountFeederTick } from "./account-feeder-tick.js";

describe("caller paid failure receipts", () => {
  it.each(["discovery", "profiler", "account-feeder"])(
    "meters the paid dataset failure in %s",
    async (worker) => {
      const client = createRotatingApifyClient({
        candidates: [{ credentialId: "actual-token", token: "fixture", wasExhausted: false }],
        buildClient: (token) =>
          createApifyXClient({
            token,
            fetchImpl: (async (_url: unknown, init?: RequestInit) => {
              if (init?.method === "POST")
                return Response.json({
                  data: {
                    id: "run",
                    status: "SUCCEEDED",
                    defaultDatasetId: "data",
                    usageTotalUsd: 0.2,
                  },
                });
              return new Response("failed", { status: 500 });
            }) as typeof fetch,
          }),
      });
      const recorder = { record: vi.fn().mockResolvedValue(undefined) };
      const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
      const instance = { id: "instance", org_id: "org" };
      const common = { instance, log, recorder, credentialId: "primary-token" };
      if (worker === "discovery")
        await runDiscoveryTick({
          ...common,
          xClient: client,
          watchlist: { handles: ["builder"], keywords: [] },
          watchlistPeople: [],
          rateBucket: { tryTake: () => true },
          upsertLead: vi.fn(),
        });
      if (worker === "profiler")
        await runProfilerTick({
          ...common,
          xClient: client,
          people: [{ handle: "builder", addedAt: "2026-10-05T00:00:00Z" }],
          rateBucket: { tryTake: () => true },
          runner: { draft: vi.fn() },
          upsertProfile: vi.fn(),
          markAttempted: vi.fn().mockResolvedValue(undefined),
        });
      if (worker === "account-feeder")
        await runAccountFeederTick({
          ...common,
          instance: instance as never,
          apify: client,
          sources: [{ id: "source", handle: "builder", platform: "x" }] as never,
          extractor: { call: vi.fn() },
          upsertStylePosts: vi.fn(),
          getCorpus: vi.fn(),
          upsertUltraProfile: vi.fn(),
          markSourcePulled: vi.fn(),
        });
      expect(recorder.record).toHaveBeenCalledOnce();
      expect(recorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ cents: 20, credentialId: "actual-token" }),
      );
      expect(client.drainRunReceipts?.()).toEqual([]);
    },
  );
});

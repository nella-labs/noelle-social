import { describe, expect, it, vi } from "vitest";
import { createApifyRotation } from "./apifyRotation.js";
import type { ApifyRunReceipt } from "./apifyRunReceipts.js";

class DomainError extends Error { constructor(readonly status: number) { super(`status ${status}`); } }
const receipt = (actualUsd: number | null, runId = "run"): ApifyRunReceipt => ({
  runId, actor: "actor", actualUsd, status: "SUCCEEDED", terminal: true,
  resultCount: 0, resultCountComplete: true, fetchedResultCount: 0,
});
function pool(values: Array<{ charge: number | null; error?: number }>) {
  const clients = values.map(value => ({ drainLastRunUsd: () => value.charge,
    drainRunReceipts: () => [receipt(value.charge)],
    run: async () => { if (value.error !== undefined) throw new DomainError(value.error); return []; } }));
  const buildClient = vi.fn((token: string) => clients[Number(token)]!);
  const rotation = createApifyRotation({ candidates: values.map((_, index) => ({ token: String(index), credentialId: String(index), wasExhausted: false })), buildClient }, {
    fatalStatus: error => error instanceof DomainError && [401, 402, 403].includes(error.status) ? error.status : null,
    exhaustedError: (count, detail) => new Error(`${count}: ${detail}`),
    limitError: () => new Error("attempt limit"),
  });
  return { rotation, buildClient };
}

describe("operation-scoped Apify rotation", () => {
  it("retains paid failed attempts and success with exact credential identity", async () => {
    const { rotation } = pool([{ charge: 0.2, error: 401 }, { charge: 0.3 }]);
    await rotation.run(client => client.run(), "actor");
    expect(rotation.drainLastRunUsd()).toBe(0.5);
    expect(rotation.drainRunReceipts().map(row => [row.credentialId, row.actualUsd])).toEqual([["0", 0.2], ["1", 0.3]]);
    expect(rotation.drainRunReceipts()).toEqual([]);
  });

  it.each([0, 502, 504])("does not replay ambiguous status %s on another token, but keeps received charge", async status => {
    const { rotation, buildClient } = pool([{ charge: 0.2, error: status }, { charge: 0.3 }]);
    await expect(rotation.run(client => client.run(), "actor")).rejects.toBeInstanceOf(DomainError);
    expect(buildClient).toHaveBeenCalledOnce();
    expect(rotation.drainRunReceipts()).toEqual([expect.objectContaining({ credentialId: "0", actualUsd: 0.2 })]);
  });

  it("keeps a mixed known/unknown operation amount unknown without losing its known receipt", async () => {
    const { rotation } = pool([{ charge: 0.2, error: 401 }, { charge: null }]);
    await rotation.run(client => client.run(), "actor");
    expect(rotation.drainLastRunUsd()).toBeNull();
    expect(rotation.drainRunReceipts().map(row => row.actualUsd)).toEqual([0.2, null]);
  });

  it("shares dead-token policy across forks but isolates receipts and paid client instances", async () => {
    const { rotation, buildClient } = pool([{ charge: 0.2, error: 401 }, { charge: 0.3 }]);
    const first = rotation.fork(); await first.run(client => client.run(), "actor");
    const second = rotation.fork(); await second.run(client => client.run(), "actor");
    expect(buildClient.mock.calls.map(([token]) => token)).toEqual(["0", "1", "1"]);
    expect(first.drainRunReceipts().map(row => row.actualUsd)).toEqual([0.2, 0.3]);
    expect(second.drainRunReceipts().map(row => row.actualUsd)).toEqual([0.3]);
    expect(rotation.drainRunReceipts()).toEqual([]);
  });

  it("admits at most 64 token attempts and retains all already received charges", async () => {
    const buildClient = vi.fn(() => ({ run: async () => { throw new DomainError(401); },
      drainRunReceipts: () => Array.from({ length: 64 }, (_, index) => receipt(0.01, String(index))) }));
    const rotation = createApifyRotation({ candidates: Array.from({ length: 65 }, (_, index) => ({
      credentialId: String(index), token: String(index), wasExhausted: false })), buildClient }, {
      fatalStatus: () => 401, exhaustedError: () => new Error("empty"), limitError: () => new Error("attempt limit"),
    });
    await expect(rotation.run(client => client.run(), "actor")).rejects.toThrow("attempt limit");
    expect(buildClient).toHaveBeenCalledTimes(64);
    const received = rotation.drainRunReceipts();
    expect(received).toHaveLength(64 * 64);
    expect(new Set(received.map(row => row.credentialId)).size).toBe(64);
    expect(received.at(-1)).toMatchObject({ credentialId: "63", runId: "63", actualUsd: 0.01 });
  });

  it("allows only the explicitly configured completed-actor fallback policy", async () => {
    const { rotation } = pool([{ charge: 0.2, error: 502 }, { charge: 0.3 }]);
    await expect(rotation.run(client => client.run(), "actor")).rejects.toBeInstanceOf(DomainError);
    const policy = createApifyRotation({ candidates: ["0", "1"].map(token => ({ token, credentialId: token, wasExhausted: false })),
      buildClient: token => ({ run: async () => { if (token === "0") throw new DomainError(502); return []; }, drainRunReceipts: () => [receipt(0.2)] }),
    }, { fatalStatus: () => null, retryActor: error => error instanceof DomainError && error.status === 502,
      maxActorRetries: 3, exhaustedError: () => new Error("empty"), limitError: () => new Error("limit") });
    await expect(policy.run(client => client.run(), "actor")).resolves.toEqual([]);
    expect(policy.drainRunReceipts()).toHaveLength(2);
  });
});

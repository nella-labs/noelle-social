import { describe, expect, it } from "vitest";
import { MemoryWorkQueue, PgWorkQueue, getWorkQueue } from "./queue.js";

describe("MemoryWorkQueue", () => {
  it("delivers enqueued jobs with attempt 0 and counts redeliveries", async () => {
    const q = new MemoryWorkQueue<{ n: number }>();
    await q.enqueue({ n: 1 });
    const [first] = await q.claim({ batchSize: 5 });
    expect(first?.job).toEqual({ n: 1 });
    expect(first?.attempt).toBe(0);

    await q.nack(first!.claimId);
    const [second] = await q.claim({ batchSize: 5 });
    expect(second?.attempt).toBe(1);
  });

  it("ack removes the job for good (claim TTL 0 would otherwise redeliver)", async () => {
    // TTL 0: a claimed-but-not-acked row is immediately claimable again, so
    // the empty re-claim below proves ack deleted it — a no-op ack would fail.
    const q = new MemoryWorkQueue<string>(0);
    await q.enqueue("a");
    const [claimed] = await q.claim({ batchSize: 1 });
    await q.ack(claimed!.claimId);
    expect(await q.claim({ batchSize: 5 })).toEqual([]);
    expect(await q.depth()).toBe(0);
  });

  it("depth counts claimable rows only (live claims and delayed jobs excluded)", async () => {
    const q = new MemoryWorkQueue<string>();
    await q.enqueue("a");
    await q.enqueue("b", { delaySeconds: 3600 });
    expect(await q.depth()).toBe(1);
    await q.claim({ batchSize: 1 });
    expect(await q.depth()).toBe(0);
  });

  it("claim honors batchSize as an upper bound", async () => {
    const q = new MemoryWorkQueue<number>();
    for (let i = 0; i < 5; i++) await q.enqueue(i);
    const claimed = await q.claim({ batchSize: 2 });
    expect(claimed).toHaveLength(2);
    expect(await q.depth()).toBe(3);
  });

  it("ack and nack on an unknown claimId are silent no-ops", async () => {
    const q = new MemoryWorkQueue<string>();
    await q.enqueue("a");
    await expect(q.ack("c_nope")).resolves.toBeUndefined();
    await expect(q.nack("c_nope")).resolves.toBeUndefined();
    expect(await q.depth()).toBe(1);
  });

  it("dedupes on the idempotency key (parity with pg's unique index)", async () => {
    const q = new MemoryWorkQueue<{ v: number }>();
    await q.enqueue({ v: 1 }, { key: "lead:42" });
    await q.enqueue({ v: 2 }, { key: "lead:42" });
    await q.enqueue({ v: 3 }, { key: "lead:43" });
    await q.enqueue({ v: 4 });
    expect(await q.depth()).toBe(3);
    const [first] = await q.claim({ batchSize: 1 });
    expect(first?.job).toEqual({ v: 1 });
  });

  it("dead-letters after maxAttempts (parity with pg)", async () => {
    const q = new MemoryWorkQueue<string>(0, 2);
    await q.enqueue("poison");
    for (let i = 0; i < 2; i++) {
      const [c] = await q.claim({ batchSize: 1 });
      expect(c?.attempt).toBe(i);
      await q.nack(c!.claimId);
    }
    expect(await q.claim({ batchSize: 5 })).toEqual([]);
    expect(await q.depth()).toBe(0);
    expect(await q.deadDepth()).toBe(1);
  });

  it("dead-letters via orphan exhaustion (TTL expiry, no nack) too", async () => {
    const q = new MemoryWorkQueue<string>(0, 2);
    await q.enqueue("crash-loop");
    for (let i = 0; i < 2; i++) {
      const [c] = await q.claim({ batchSize: 1 });
      expect(c?.attempt).toBe(i);
    }
    expect(await q.claim({ batchSize: 5 })).toEqual([]);
    expect(await q.depth()).toBe(0);
    expect(await q.deadDepth()).toBe(1);
  });

  it("expired claims are redelivered (orphan reclaim)", async () => {
    const q = new MemoryWorkQueue<string>(0);
    await q.enqueue("job");
    const [first] = await q.claim({ batchSize: 1 });
    expect(first).toBeDefined();
    const [again] = await q.claim({ batchSize: 1 });
    expect(again?.job).toBe("job");
    expect(again?.attempt).toBe(1);
  });
});

describe("getWorkQueue", () => {
  it("defaults to the memory driver", () => {
    expect(getWorkQueue()).toBeInstanceOf(MemoryWorkQueue);
  });

  it("builds a PgWorkQueue when given an executor + queue name", () => {
    const q = getWorkQueue({ driver: "pg", executor: async () => [], queue: "t" });
    expect(q).toBeInstanceOf(PgWorkQueue);
  });

  it("rejects driver=pg without executor/queue", () => {
    expect(() => getWorkQueue({ driver: "pg" })).toThrow(/executor and queue/);
  });

  it("honors claimTtlSeconds and maxAttempts on the memory driver too", async () => {
    const q = getWorkQueue<string>({ driver: "memory", claimTtlSeconds: 0, maxAttempts: 1 });
    await q.enqueue("one-shot");
    const [c] = await q.claim({ batchSize: 1 });
    expect(c?.attempt).toBe(0);
    // TTL 0 honored: the claim is already expired — yet maxAttempts 1 is
    // honored too, so the job is exhausted, not redelivered.
    expect(await q.claim({ batchSize: 5 })).toEqual([]);
    expect(await q.depth()).toBe(0);
  });
});

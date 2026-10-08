import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./cache.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("MemoryCache", () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid entry bound %j", maximum => {
    expect(() => new MemoryCache(maximum)).toThrow(RangeError);
  });
  it("recovers after a compute function throws before returning a promise", async () => {
    const cache = new MemoryCache();
    await expect(cache.getOrCompute("key", 60, () => { throw new Error("first failure"); })).rejects.toThrow("first failure");
    await expect(cache.getOrCompute("key", 60, async () => "recovered")).resolves.toBe("recovered");
    expect(await cache.get("key")).toBe("recovered");
  });

  it("collapses concurrent misses and recovers after an asynchronous failure", async () => {
    const cache = new MemoryCache();
    const value = deferred<string>(), started = deferred<void>();
    const compute = vi.fn(() => { started.resolve(); return value.promise; });
    const first = cache.getOrCompute("key", 60, compute);
    await started.promise;
    const second = cache.getOrCompute("key", 60, compute);
    value.resolve("shared");
    expect(await Promise.all([first, second])).toEqual(["shared", "shared"]);
    expect(compute).toHaveBeenCalledOnce();
    await cache.del("key");
    await expect(cache.getOrCompute("key", 60, async () => { throw new Error("later failure"); })).rejects.toThrow("later failure");
    expect(await cache.getOrCompute("key", 60, async () => "new")).toBe("new");
  });

  it("does not publish an invalidated result or erase a newer computation", async () => {
    const cache = new MemoryCache();
    const oldValue = deferred<string>(), oldStarted = deferred<void>();
    const newValue = deferred<string>(), newStarted = deferred<void>();
    const oldCall = cache.getOrCompute("key", 60, () => { oldStarted.resolve(); return oldValue.promise; });
    await oldStarted.promise;
    await cache.del("key");
    const newer = vi.fn(() => { newStarted.resolve(); return newValue.promise; });
    const newCall = cache.getOrCompute("key", 60, newer);
    await newStarted.promise;
    oldValue.resolve("old");
    try {
      expect(await oldCall).toBe("old");
      expect(await cache.get("key")).toBeUndefined();
      const extra = vi.fn(async () => "unexpected");
      const joined = cache.getOrCompute("key", 60, extra);
      newValue.resolve("new");
      expect(await Promise.all([newCall, joined])).toEqual(["new", "new"]);
      expect(extra).not.toHaveBeenCalled();
      expect(await cache.get("key")).toBe("new");
    } finally { newValue.resolve("new"); await newCall; }
  });

  it("updating a full cache does not evict an unrelated key", async () => {
    const cache = new MemoryCache(2);
    await cache.set("a", "one", 60); await cache.set("b", "two", 60);
    await cache.set("b", "updated", 60);
    expect(await cache.get("a")).toBe("one");
    expect(await cache.get("b")).toBe("updated");
  });

  it("evicts the least recently read key", async () => {
    const cache = new MemoryCache(2);
    await cache.set("a", "one", 60); await cache.set("b", "two", 60);
    expect(await cache.get("a")).toBe("one");
    await cache.set("c", "three", 60);
    expect(await cache.get("a")).toBe("one");
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("c")).toBe("three");
  });

  it("expires zero-TTL values and preserves falsy cached values", async () => {
    const cache = new MemoryCache();
    await cache.set("expired", "gone", 0);
    expect(await cache.get("expired")).toBeUndefined();
    const compute = vi.fn(async () => 123);
    await cache.set("zero", 0, 60);
    expect(await cache.getOrCompute("zero", 60, compute)).toBe(0);
    expect(compute).not.toHaveBeenCalled();
  });
});

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "validates a separate executing-fill capacity %j", maximum => {
    expect(() => new MemoryCache(2, maximum)).toThrow(RangeError);
  },
);

it("admits hits and same-key joins while rejecting new executing work", async () => {
  const cache = new MemoryCache(2, 1);
  const gate = deferred<string>(), started = deferred<void>();
  await cache.set("hit", 0, 60);
  const compute = vi.fn(() => { started.resolve(); return gate.promise; });
  const first = cache.getOrCompute("pending", 60, compute);
  await started.promise;
  const extra = vi.fn(async () => "extra");
  let joined: Promise<string> | undefined;
  try {
    expect(await cache.getOrCompute("hit", 60, extra)).toBe(0);
    joined = cache.getOrCompute("pending", 60, extra);
    await expect(cache.getOrCompute("new", 60, extra)).rejects.toMatchObject({ name: "CacheBusyError" });
    expect(extra).not.toHaveBeenCalled();
    gate.resolve("shared");
    expect(await Promise.all([first, joined])).toEqual(["shared", "shared"]);
    expect(await cache.getOrCompute("new", 60, extra)).toBe("extra");
  } finally {
    gate.resolve("shared");
    await Promise.allSettled([first, joined]);
  }
});

it.each(["del", "clear", "set"] as const)(
  "holds invalidated executing capacity through %s until actual settlement", async operation => {
    const cache = new MemoryCache(2, 1);
    const gate = deferred<string>(), started = deferred<void>();
    const first = cache.getOrCompute("key", 60, () => { started.resolve(); return gate.promise; });
    await started.promise;
    let attempted: Promise<unknown> | undefined;
    try {
      if (operation === "del") await cache.del("key");
      else if (operation === "clear") cache.clear();
      else await cache.set("key", "expired-write", 0);
      const extra = vi.fn(async () => "current");
      let outcome: unknown;
      attempted = cache.getOrCompute("key", 60, extra).then(
        value => { outcome = value; },
        error => { outcome = error; },
      );
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(outcome).toMatchObject({ name: "CacheBusyError" });
      expect(extra).not.toHaveBeenCalled();
      gate.resolve("invalidated-old");
      expect(await first).toBe("invalidated-old");
      expect(await cache.get("key")).toBeUndefined();
      expect(await cache.getOrCompute("key", 60, extra)).toBe("current");
    } finally {
      gate.resolve("invalidated-old");
      await Promise.allSettled([first, attempted]);
    }
  },
);

it("caps the default executing set at 32 even after clear invalidates every key", async () => {
  const cache = new MemoryCache(), gate = deferred<string>();
  const compute = vi.fn(() => gate.promise);
  const pending = Array.from({ length: 32 }, (_, i) => cache.getOrCompute(`key-${i}`, 60, compute));
  await new Promise<void>(resolve => setImmediate(resolve));
  const extra = vi.fn(async () => "unexpected");
  try {
    await expect(cache.getOrCompute("overflow", 60, extra)).rejects.toMatchObject({ name: "CacheBusyError" });
    cache.clear();
    await expect(cache.getOrCompute("after-clear", 60, extra)).rejects.toMatchObject({ name: "CacheBusyError" });
    expect(compute).toHaveBeenCalledTimes(32);
    expect(extra).not.toHaveBeenCalled();
    gate.resolve("old");
    await Promise.all(pending);
    expect(await cache.get("key-0")).toBeUndefined();
    expect(await cache.getOrCompute("recovered", 60, async () => "new")).toBe("new");
  } finally {
    gate.resolve("old");
    await Promise.allSettled(pending);
  }
});

it.each(["sync", "async"] as const)("releases capacity after %s computation failure", async mode => {
  const cache = new MemoryCache(2, 1);
  const compute = mode === "sync"
    ? () => { throw new Error("failed computation"); }
    : async () => { throw new Error("failed computation"); };
  await expect(cache.getOrCompute("key", 60, compute)).rejects.toThrow("failed computation");
  expect(await cache.getOrCompute("key", 60, async () => "recovered")).toBe("recovered");
});

it.each([60, 0])("preserves a later explicit set with TTL %s against an earlier fill", async ttl => {
  const cache = new MemoryCache();
  const started = deferred<void>(), value = deferred<string>();
  const older = cache.getOrCompute("key", 60, () => { started.resolve(); return value.promise; });
  await started.promise;
  try {
    await cache.set("key", "explicit-new", ttl);
    const expected = ttl === 0 ? undefined : "explicit-new";
    expect(await cache.get("key")).toBe(expected);
    value.resolve("computed-old");
    expect(await older).toBe("computed-old");
    expect(await cache.get("key")).toBe(expected);
  } finally {
    value.resolve("computed-old");
    await older;
  }
});

it("does not invalidate another key's pending fill", async () => {
  const cache = new MemoryCache();
  const started = deferred<void>(), value = deferred<string>();
  const compute = vi.fn(() => { started.resolve(); return value.promise; });

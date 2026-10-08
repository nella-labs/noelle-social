// Tests for the readyCache consolidated out of
// apps/{x,linkedin,reddit}-intern/src/lib/ready-cache.ts.
//
// None of the three interns shipped a test for this file, so there was no
// existing coverage to carry over or union — these cases are new and pin the
// behaviour the three copies shared, including the two contracts the x copy's
// JSDoc called out explicitly (once per tuple per process; a throwing check
// does NOT mark the tuple ready).

import { describe, it, expect, vi } from "vitest";
import { createReadyCache } from "./readyCache.js";

describe("createReadyCache", () => {
  it("runs the check once per (orgId, kind) per process", async () => {
    const ready = createReadyCache();
    const check = vi.fn(async () => {});

    await ready.ensure("org-1", "x-cookies", check);
    await ready.ensure("org-1", "x-cookies", check);
    await ready.ensure("org-1", "x-cookies", check);

    expect(check).toHaveBeenCalledTimes(1);
  });

  it("keys on both orgId and kind, so neither leaks into the other", async () => {
    const ready = createReadyCache();
    const check = vi.fn(async () => {});

    await ready.ensure("org-1", "x-cookies", check);
    await ready.ensure("org-2", "x-cookies", check); // different org
    await ready.ensure("org-1", "linkedin-li-at", check); // different kind
    await ready.ensure("org-1", "x-cookies", check); // already ready

    expect(check).toHaveBeenCalledTimes(3);
  });

  it("does NOT mark the tuple ready when the check throws, and propagates", async () => {
    const ready = createReadyCache();
    const check = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("secret fetch failed"))
      .mockResolvedValue(undefined);

    await expect(ready.ensure("org-1", "x-cookies", check)).rejects.toThrow(
      "secret fetch failed",
    );
    // Next tick retries...
    await ready.ensure("org-1", "x-cookies", check);
    // ...and once it succeeds the tuple is cached.
    await ready.ensure("org-1", "x-cookies", check);

    expect(check).toHaveBeenCalledTimes(2);
  });

  it("does not swallow a synchronous throw from the check either", async () => {
    const ready = createReadyCache();
    const check = vi.fn(() => {
      throw new Error("boom");
    }) as unknown as () => Promise<void>;

    await expect(ready.ensure("org-1", "x-cookies", check)).rejects.toThrow("boom");
    await expect(ready.ensure("org-1", "x-cookies", check)).rejects.toThrow("boom");
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("reset() clears exactly one entry", async () => {
    const ready = createReadyCache();
    const check = vi.fn(async () => {});

    await ready.ensure("org-1", "x-cookies", check);
    await ready.ensure("org-1", "linkedin-li-at", check);
    expect(check).toHaveBeenCalledTimes(2);

    ready.reset("org-1", "x-cookies");
    await ready.ensure("org-1", "x-cookies", check); // re-runs
    await ready.ensure("org-1", "linkedin-li-at", check); // still cached

    expect(check).toHaveBeenCalledTimes(3);
  });

  it("reset() on an unknown entry is a no-op", async () => {
    const ready = createReadyCache();
    const check = vi.fn(async () => {});

    ready.reset("nope", "nope");
    await ready.ensure("org-1", "x-cookies", check);
    await ready.ensure("org-1", "x-cookies", check);

    expect(check).toHaveBeenCalledTimes(1);
  });

  it("clear() drops every entry", async () => {
    const ready = createReadyCache();
    const check = vi.fn(async () => {});

    await ready.ensure("org-1", "x-cookies", check);
    await ready.ensure("org-2", "reddit-session", check);
    ready.clear();
    await ready.ensure("org-1", "x-cookies", check);
    await ready.ensure("org-2", "reddit-session", check);

    expect(check).toHaveBeenCalledTimes(4);
  });

  it("gives each cache instance its own state", async () => {
    const a = createReadyCache();
    const b = createReadyCache();
    const check = vi.fn(async () => {});

    await a.ensure("org-1", "x-cookies", check);
    await b.ensure("org-1", "x-cookies", check);

    expect(check).toHaveBeenCalledTimes(2);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it.each(["reset", "clear"] as const)("preserves new readiness ownership after pending %s", async operation => {
  const ready = createReadyCache({ maxEntries: 2, maxExecuting: 2 });
  const oldGate = deferred(), oldStarted = deferred(), newGate = deferred(), newStarted = deferred();
  const oldCall = ready.ensure("org", "kind", async () => { oldStarted.resolve(); await oldGate.promise; });
  await oldStarted.promise;
  if (operation === "reset") ready.reset("org", "kind"); else ready.clear();
  const newer = vi.fn(async () => { newStarted.resolve(); await newGate.promise; });
  const newCall = ready.ensure("org", "kind", newer);
  await newStarted.promise;
  let joined: Promise<void> | undefined;
  try {
    oldGate.resolve();
    await oldCall;
    const extra = vi.fn(async () => {});
    let joinedSettled = false;
    joined = ready.ensure("org", "kind", extra).then(() => { joinedSettled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(joinedSettled).toBe(false);
    newGate.resolve();
    await Promise.all([newCall, joined]);
    await ready.ensure("org", "kind", extra);
    expect(newer).toHaveBeenCalledOnce();
    expect(extra).not.toHaveBeenCalled();
  } finally {
    oldGate.resolve();
    newGate.resolve();
    await Promise.allSettled([oldCall, newCall, joined]);
  }
});

it("holds busy readiness until the invalidated check settles", async () => {
  const ready = createReadyCache({ maxEntries: 2, maxExecuting: 1 });
  const gate = deferred(), started = deferred();
  const first = ready.ensure("org", "kind", async () => { started.resolve(); await gate.promise; });
  await started.promise;
  try {
    ready.reset("org", "kind");
    const fresh = vi.fn(async () => {});
    await expect(ready.ensure("org", "kind", fresh)).rejects.toMatchObject({ name: "CacheBusyError" });
    expect(fresh).not.toHaveBeenCalled();
    gate.resolve();
    await first;
    await ready.ensure("org", "kind", fresh);
    expect(fresh).toHaveBeenCalledOnce();
  } finally {
    gate.resolve();
    await first;
  }
});

it("retains bounded LRU readiness and rechecks an evicted tuple", async () => {
  const ready = createReadyCache({ maxEntries: 2, maxExecuting: 1 });
  const a = vi.fn(async () => {}), b = vi.fn(async () => {}), c = vi.fn(async () => {});
  await ready.ensure("a", "kind", a);
  await ready.ensure("b", "kind", b);
  await ready.ensure("a", "kind", a);
  await ready.ensure("c", "kind", c);
  await ready.ensure("b", "kind", b);
  expect(a).toHaveBeenCalledOnce();
  expect(c).toHaveBeenCalledOnce();
  expect(b).toHaveBeenCalledTimes(2);
});

it("separates exact tuple strings without separator collisions", async () => {
  const ready = createReadyCache(), check = vi.fn(async () => {});
  await ready.ensure("org::part", "kind", check);
  await ready.ensure("org", "part::kind", check);
  expect(check).toHaveBeenCalledTimes(2);
});

it("shares overlapping checks for the same tuple", async () => {
  const ready = createReadyCache(), gate = deferred(), started = deferred();
  const check = vi.fn(async () => { started.resolve(); await gate.promise; });
  const first = ready.ensure("org", "kind", check);
  await started.promise;
  const second = ready.ensure("org", "kind", check);
  try {
    gate.resolve();

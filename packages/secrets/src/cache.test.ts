import { describe, expect, it, vi } from "vitest";
import { createSecretsClient, SecretAccessError } from "./index.js";
const value = (data: string): [{ payload: { data: string } }] => [{ payload: { data } }];
function held() {
  let finish!: (response: ReturnType<typeof value>) => void;
  const pending = new Promise<ReturnType<typeof value>>((resolve) => {
    finish = resolve;
  });
  return { pending, finish };
}
describe("secret cache and resource boundaries", () => {
  it("coalesces simultaneous identical reads", async () => {
    const gate = held(),
      access = vi.fn(() => gate.pending);
    const client = createSecretsClient({
      project: "fixture",
      client: { accessSecretVersion: access },
    });
    const reads = Array.from({ length: 8 }, () => client.get("one"));
    try {
      expect(access).toHaveBeenCalledTimes(1);
    } finally {
      gate.finish(value("fixture"));
      await Promise.all(reads);
    }
  });
  it("does not restore an invalidated older in-flight secret", async () => {
    const first = held(),
      next = held();
    const access = vi
      .fn()
      .mockImplementationOnce(() => first.pending)
      .mockImplementationOnce(() => next.pending);
    const client = createSecretsClient({
      project: "fixture",
      client: { accessSecretVersion: access },
    });
    const old = client.get("one");
    client.bust("one");
    const fresh = client.get("one");
    next.finish(value("fresh"));
    expect(await fresh).toBe("fresh");
    first.finish(value("old"));
    expect(await old).toBe("old");
    expect(await client.get("one")).toBe("fresh");
  });
  it("bounds retained completed cache entries", async () => {
    const access = vi.fn(async () => value("fixture"));
    const client = createSecretsClient({
      project: "fixture",
      now: () => 0,
      client: { accessSecretVersion: access },
    });
    for (let i = 0; i < 260; i++) await client.get(`entry-${i}`);
    await client.get("entry-0");
    expect(access).toHaveBeenCalledTimes(261);
  });
  it("bounds warm concurrency while preserving the complete input", async () => {
    const gate = held(),
      access = vi.fn(() => gate.pending);
    const client = createSecretsClient({
      project: "fixture",
      client: { accessSecretVersion: access },
    });
    const warming = client.warm(Array.from({ length: 100 }, (_, i) => `entry-${i}`));
    try {
      await vi.waitFor(() => expect(access.mock.calls.length).toBeGreaterThan(0));
      expect(access.mock.calls.length).toBeLessThanOrEqual(4);
    } finally {
      gate.finish(value("fixture"));
      await warming;
    }
    expect(access).toHaveBeenCalledTimes(100);
  });
  it("bounds distinct admitted reads", async () => {
    const gate = held(),
      access = vi.fn(() => gate.pending);
    const client = createSecretsClient({
      project: "fixture",
      client: { accessSecretVersion: access },
    });
    const reads = Array.from({ length: 35 }, (_, i) =>
      client.get(`entry-${i}`).catch((error) => error),
    );
    try {
      expect(access.mock.calls.length).toBeLessThanOrEqual(4);
    } finally {
      gate.finish(value("fixture"));
      const outcomes = await Promise.all(reads);
      expect(outcomes.filter((response) => response instanceof SecretAccessError)).toHaveLength(3);
    }
  });
  it("keeps provider error content out of public errors", async () => {
    const client = createSecretsClient({
      project: "fixture",
      client: {
        accessSecretVersion: async () => {
          throw new Error("fixture-secret fixture-token");
        },
      },
    });
    await expect(client.get("one")).rejects.toThrow(/^Secret access failed reading one$/);
  });
  it("refuses payload beyond64KiB", async () => {
    const client = createSecretsClient({
      project: "fixture",
      client: { accessSecretVersion: async () => value("x".repeat(65537)) },
    });
    await expect(client.get("one")).rejects.toBeInstanceOf(SecretAccessError);
  });
  it("preserves measured string0 and TTL", async () => {
    let now = 0;
    const access = vi.fn(async () => value("0"));
    const client = createSecretsClient({
      project: "fixture",
      ttlMs: 1000,
      now: () => now,
      client: { accessSecretVersion: access },
    });
    expect(await client.get("one")).toBe("0");
    expect(await client.get("one")).toBe("0");
    expect(access).toHaveBeenCalledTimes(1);
    now = 1001;
    expect(await client.get("one")).toBe("0");
    expect(access).toHaveBeenCalledTimes(2);
  });
  it("uses legacy org fallback only for missing secrets", async () => {
    const access = vi.fn().mockRejectedValueOnce({ code: 5 }).mockResolvedValue(value("legacy"));
    const client = createSecretsClient({
      project: "fixture",
      client: { accessSecretVersion: access },
    });
    expect(await client.getForOrg("fixture-org", "key")).toBe("legacy");
    expect(access).toHaveBeenCalledTimes(2);
  });
  it("does not fall back after permission denial", async () => {
    const access = vi.fn().mockRejectedValue({ code: 7 });
    const client = createSecretsClient({
      project: "fixture",
      client: { accessSecretVersion: access },
    });
    await expect(client.getForOrg("fixture-org", "key")).rejects.toThrow("PERMISSION_DENIED");
    expect(access).toHaveBeenCalledTimes(1);
  });
  it("refreshes LRU order when a completed entry is read", async () => {
    const access = vi.fn(async () => value("fixture"));
    const client = createSecretsClient({
      project: "fixture",
      now: () => 0,
      client: { accessSecretVersion: access },
    });
    for (let i = 0; i < 256; i++) await client.get(`entry-${i}`);
    await client.get("entry-0");
    await client.get("entry-256");
    await client.get("entry-0");
    expect(access).toHaveBeenCalledTimes(257);
    await client.get("entry-1");
    expect(access).toHaveBeenCalledTimes(258);
  });
  it("clears failed coalesced reads so the same key can recover", async () => {
    const access = vi
      .fn()
      .mockRejectedValueOnce(new Error("fixture failure"))
      .mockResolvedValue(value("healthy"));
    const client = createSecretsClient({
      project: "fixture",
      client: { accessSecretVersion: access },
    });
    const failures = await Promise.all(
      Array.from({ length: 8 }, () => client.get("one").catch((error) => error)),
    );
    expect(failures.every((error) => error instanceof SecretAccessError)).toBe(true);
    expect(access).toHaveBeenCalledTimes(1);
    expect(await client.get("one")).toBe("healthy");
    expect(access).toHaveBeenCalledTimes(2);
  });
  it("does not let provider message text authorize missing-secret fallback", async () => {
    const access = vi.fn().mockRejectedValue(new Error("NOT_FOUND fixture-secret"));
    const client = createSecretsClient({
      project: "fixture",
      client: { accessSecretVersion: access },
    });
    await expect(client.getForOrg("org", "key")).rejects.toMatchObject({ code: "failed" });
    expect(access).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createSecretsClient, SecretAccessError } from "./secrets.js";

describe("secrets client", () => {
  it("caches secrets across calls within TTL", async () => {
    const access = vi.fn().mockResolvedValue([{ payload: { data: Buffer.from("v1") } }]);
    const client = createSecretsClient({
      project: "noelle-agents",
      ttlMs: 60_000,
      now: () => 0,
      client: { accessSecretVersion: access } as never,
    });
    expect(await client.get("noelle-worker-x-cookies-ct0")).toBe("v1");
    expect(await client.get("noelle-worker-x-cookies-ct0")).toBe("v1");
    expect(access).toHaveBeenCalledTimes(1);
  });

  it("normalises legacy slash names and caches under dash form", async () => {
    const access = vi.fn().mockResolvedValue([{ payload: { data: Buffer.from("v1") } }]);
    const client = createSecretsClient({
      project: "noelle-agents",
      ttlMs: 60_000,
      now: () => 0,
      client: { accessSecretVersion: access } as never,
    });
    // Old callers may still pass slash names — they should normalise to dashes.
    expect(await client.get("noelle/worker/x-cookies-ct0")).toBe("v1");
    // The resource name passed to GCP must use dashes, not slashes.
    const calledName: string = (access.mock.calls[0] as [{ name: string }])[0].name;
    expect(calledName).not.toContain("/secrets/noelle/");
    expect(calledName).toContain("noelle-worker-x-cookies-ct0");
  });

  it("re-fetches after TTL expires", async () => {
    const access = vi
      .fn()
      .mockResolvedValueOnce([{ payload: { data: Buffer.from("v1") } }])
      .mockResolvedValueOnce([{ payload: { data: Buffer.from("v2") } }]);
    let t = 0;
    const client = createSecretsClient({
      project: "noelle-agents",
      ttlMs: 60_000,
      now: () => t,
      client: { accessSecretVersion: access } as never,
    });
    expect(await client.get("k")).toBe("v1");
    t = 70_000;
    expect(await client.get("k")).toBe("v2");
    expect(access).toHaveBeenCalledTimes(2);
  });

  it("throws SecretAccessError on PERMISSION_DENIED", async () => {
    const access = vi.fn().mockRejectedValue(Object.assign(new Error("denied"), { code: 7 }));
    const client = createSecretsClient({
      project: "noelle-agents",
      ttlMs: 60_000,
      now: () => 0,
      client: { accessSecretVersion: access } as never,
    });
    await expect(client.get("k")).rejects.toThrow(/PERMISSION_DENIED|denied/);
  });

  describe("getForOrg", () => {
    it("returns per-org secret when found", async () => {
      const access = vi.fn().mockResolvedValue([{ payload: { data: Buffer.from("org-value") } }]);
      const client = createSecretsClient({
        project: "noelle-agents",
        ttlMs: 60_000,
        now: () => 0,
        client: { accessSecretVersion: access } as never,
      });
      const result = await client.getForOrg("org-123", "x-cookies-ct0");
      expect(result).toBe("org-value");
      // Should have tried the per-org name first
      const calledName: string = (access.mock.calls[0] as [{ name: string }])[0].name;
      expect(calledName).toContain("noelle--org--org-123--x-cookies-ct0");
    });

    it("falls back to legacy flat name when per-org secret is NOT_FOUND", async () => {
      const access = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("not found"), { code: 5 }))
        .mockResolvedValueOnce([{ payload: { data: Buffer.from("legacy-value") } }]);
      const client = createSecretsClient({
        project: "noelle-agents",
        ttlMs: 60_000,
        now: () => 0,
        client: { accessSecretVersion: access } as never,
      });
      const result = await client.getForOrg("org-123", "x-cookies-ct0");
      expect(result).toBe("legacy-value");
      expect(access).toHaveBeenCalledTimes(2);
      // Second call must use the legacy flat name
      const legacyCall: string = (access.mock.calls[1] as [{ name: string }])[0].name;
      expect(legacyCall).toContain("noelle-worker-x-cookies-ct0");
    });

    it("throws SecretAccessError when both per-org and legacy are NOT_FOUND", async () => {
      const access = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("not found"), { code: 5 }));
      const client = createSecretsClient({
        project: "noelle-agents",
        ttlMs: 60_000,
        now: () => 0,
        client: { accessSecretVersion: access } as never,
      });
      await expect(client.getForOrg("org-123", "x-cookies-ct0")).rejects.toThrow(SecretAccessError);
      await expect(client.getForOrg("org-123", "x-cookies-ct0")).rejects.toThrow(/NOT_FOUND/);
    });

    it("does not fall back on PERMISSION_DENIED — propagates immediately", async () => {
      const access = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("denied"), { code: 7 }));
      const client = createSecretsClient({
        project: "noelle-agents",
        ttlMs: 60_000,
        now: () => 0,
        client: { accessSecretVersion: access } as never,
      });
      await expect(client.getForOrg("org-abc", "gemini-api-key")).rejects.toThrow(/PERMISSION_DENIED/);
      // Only one attempt — no fallback on PERMISSION_DENIED
      expect(access).toHaveBeenCalledTimes(1);
    });

    it("bust() evicts a cached entry so the next read re-fetches", async () => {
      const access = vi
        .fn()
        .mockResolvedValueOnce([{ payload: { data: Buffer.from("v1") } }])
        .mockResolvedValueOnce([{ payload: { data: Buffer.from("v2") } }]);
      const client = createSecretsClient({
        project: "noelle-agents",
        ttlMs: 60_000,
        now: () => 0,
        client: { accessSecretVersion: access } as never,
      });
      expect(await client.get("noelle--org--org-a--gemini-api-key")).toBe("v1");
      // Without bust(), the cache would serve v1 again within TTL.
      client.bust("noelle--org--org-a--gemini-api-key");
      expect(await client.get("noelle--org--org-a--gemini-api-key")).toBe("v2");
      expect(access).toHaveBeenCalledTimes(2);
    });

    it("bust() on an uncached id is a no-op (does not throw)", () => {
      const access = vi.fn();
      const client = createSecretsClient({
        project: "noelle-agents",
        ttlMs: 60_000,
        now: () => 0,
        client: { accessSecretVersion: access } as never,
      });
      expect(() => client.bust("never-cached")).not.toThrow();
      expect(access).not.toHaveBeenCalled();
    });

    it("default TTL is ~1 minute so workers pick up rotations quickly", async () => {
      const access = vi
        .fn()
        .mockResolvedValueOnce([{ payload: { data: Buffer.from("v1") } }])
        .mockResolvedValueOnce([{ payload: { data: Buffer.from("v2") } }]);
      let t = 0;
      const client = createSecretsClient({
        project: "noelle-agents",
        // ttlMs intentionally omitted — exercising the default
        now: () => t,
        client: { accessSecretVersion: access } as never,
      });
      expect(await client.get("k")).toBe("v1");
      // 61s later, the default TTL should have expired and trigger a re-fetch.
      t = 61_000;
      expect(await client.get("k")).toBe("v2");
      expect(access).toHaveBeenCalledTimes(2);
    });

    it("caches per-org secret independently from other orgs", async () => {
      const access = vi
        .fn()
        .mockResolvedValueOnce([{ payload: { data: Buffer.from("org-a-val") } }])
        .mockResolvedValueOnce([{ payload: { data: Buffer.from("org-b-val") } }]);
      const client = createSecretsClient({
        project: "noelle-agents",
        ttlMs: 60_000,
        now: () => 0,
        client: { accessSecretVersion: access } as never,
      });
      expect(await client.getForOrg("org-a", "gemini-api-key")).toBe("org-a-val");
      expect(await client.getForOrg("org-b", "gemini-api-key")).toBe("org-b-val");
      // Cached — no additional calls
      expect(await client.getForOrg("org-a", "gemini-api-key")).toBe("org-a-val");
      expect(access).toHaveBeenCalledTimes(2);
    });
  });
});

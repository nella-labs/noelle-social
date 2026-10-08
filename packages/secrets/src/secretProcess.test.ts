import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { nativeSecrets, options, secret, serve, token, until } from "./secretProcess.fixture.js";
afterEach(() => vi.useRealTimers());

it("owns the actual OAuth lifetime, closes its socket before rejection and recovers", async () => {
  const create = await nativeSecrets();
  let healthy = false,
    authHits = 0,
    providerHits = 0;
  const server = await serve((req, res) => {
    if (req.url === "/token") {
      authHits++;
      if (healthy) token(res);
    } else {
      providerHits++;
      secret(res);
    }
  });
  const client = create(options(server));
  let pending: Promise<unknown> | undefined;
  try {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    pending = client.get("one").catch((error) => error);
    await until(() => authHits === 1);
    expect(providerHits).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ code: "timeout" });
    await until(() => server.sockets.size === 0);
    await delay(100);
    expect(authHits).toBe(1);
    expect(providerHits).toBe(0);
    vi.useRealTimers();
    healthy = true;
    expect(await client.get("one")).toBe("fixture-value");
    expect(providerHits).toBe(1);
    await until(() => server.sockets.size === 0);
  } finally {
    if (pending && vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    }
    vi.useRealTimers();
    await server.close();
  }
}, 15_000);
it("bounds actual unfinished SDK response lifetime after valid JSON bytes", async () => {
  const create = await nativeSecrets();
  let written = false,
    settled = false;
  const server = await serve((req, res) => {
    if (req.url === "/token") token(res);
    else {
      res.write(
        JSON.stringify({ payload: { data: Buffer.from("fixture").toString("base64") } }),
        () => {
          written = true;
        },
      );
    }
  });
  let pending: Promise<unknown> | undefined;
  try {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    pending = create(options(server))
      .get("one")
      .then(
        (value) => {
          settled = true;
          return value;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
    await until(() => written);
    await delay(80);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ code: "timeout" });
    await until(() => server.sockets.size === 0);
  } finally {
    if (pending && vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    }
    vi.useRealTimers();
    await server.close();
  }
}, 15_000);
it("executes four native processes, rejects overflow and never dispatches expired queued reads", async () => {
  const create = await nativeSecrets();
  let hits = 0,
    healthy = false;
  const server = await serve((req, res) => {
    if (req.url === "/token") token(res);
    else {
      hits++;
      if (healthy) secret(res);
    }
  });
  const client = create(options(server)),
    pending: Promise<unknown>[] = [];
  try {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    for (let i = 0; i < 32; i++) pending.push(client.get(`entry-${i}`).catch((error) => error));
    await expect(client.get("overflow")).rejects.toMatchObject({ code: "busy" });
    await until(() => hits === 4);
    expect(hits).toBe(4);
    await vi.advanceTimersByTimeAsync(30_000);
    for (const outcome of await Promise.all(pending))
      expect(outcome).toMatchObject({ code: "timeout" });
    await until(() => server.sockets.size === 0);
    await delay(100);
    expect(hits).toBe(4);
    vi.useRealTimers();
    healthy = true;
    expect(await client.get("recovery")).toBe("fixture-value");
    expect(hits).toBe(5);
  } finally {
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.all(pending);
    }
    vi.useRealTimers();
    await server.close();
  }
}, 15_000);
it.each([403, 500])(
  "keeps native status%s private, without legacy fallback or SDK retry",
  async (status) => {
    const create = await nativeSecrets();
    let hits = 0;
    const server = await serve((req, res) => {
      if (req.url === "/token") token(res);
      else {
        hits++;
        res.statusCode = status;
        res.end(
          JSON.stringify({ error: { code: status, message: "fixture-secret fixture-token" } }),
        );
      }
    });
    try {
      await expect(create(options(server)).getForOrg("org", "key")).rejects.toMatchObject({
        code: status === 403 ? "PERMISSION_DENIED" : "failed",
      });
      expect(hits).toBe(1);
      await until(() => server.sockets.size === 0);
    } finally {
      await server.close();
    }
  },
);
it.each([65536, 65537])(
  "validates actual payload%s bytes inside the fixed SDK heap",
  async (size) => {
    const create = await nativeSecrets();
    let hits = 0;
    const server = await serve((req, res) => {
      if (req.url === "/token") token(res);
      else {
        hits++;
        secret(res, "x".repeat(size));
      }
    });
    try {
      const pending = create(options(server)).get("one");
      if (size === 65536) expect(await pending).toHaveLength(size);
      else await expect(pending).rejects.toMatchObject({ code: "body_too_large" });
      expect(hits).toBe(1);
      await until(() => server.sockets.size === 0);
    } finally {
      await server.close();
    }
  },
);
it("shares the original native deadline across missing org and legacy secret reads", async () => {
  const create = await nativeSecrets();
  let hits = 0,
    first: import("node:http").ServerResponse | undefined;
  const server = await serve((req, res) => {
    if (req.url === "/token") token(res);
    else {
      hits++;
      if (hits === 1) first = res;
    }
  });
  let pending: Promise<unknown> | undefined;
  try {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    pending = create(options(server))
      .getForOrg("org", "key")
      .catch((error) => error);
    await until(() => !!first);
    await vi.advanceTimersByTimeAsync(25_000);
    first!.statusCode = 404;
    first!.end(JSON.stringify({ error: { code: 404, message: "missing" } }));
    await until(() => hits === 2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ code: "timeout" });
    await until(() => server.sockets.size === 0);
    await delay(80);
    expect(hits).toBe(2);
  } finally {
    if (pending && vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    }
    vi.useRealTimers();
    await server.close();
  }
}, 15_000);
it("does not treat an OAuth404 as a missing secret or dispatch a legacy read", async () => {
  const create = await nativeSecrets();
  let authHits = 0,
    providerHits = 0;
  const server = await serve((req, res) => {
    if (req.url === "/token") {
      authHits++;
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "fixture auth unavailable" }));
    } else {
      providerHits++;
      secret(res);
    }
  });
  try {
    await expect(create(options(server)).getForOrg("org", "key")).rejects.toMatchObject({
      code: "failed",
    });
    expect(authHits).toBe(1);
    expect(providerHits).toBe(0);
    await until(() => server.sockets.size === 0);
  } finally {
    await server.close();
  }
});
it("enforces a real whole-call clock while native OAuth is stalled", async () => {
  const create = await nativeSecrets();
  let authHits = 0,
    providerHits = 0;
  const server = await serve((req, res) => {
    if (req.url === "/token") authHits++;
    else {
      providerHits++;
      secret(res);
    }
  });
  const started = performance.now();
  try {
    await expect(create({ ...options(server), timeoutMs: 1200 }).get("one")).rejects.toMatchObject({
      code: "timeout",
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1100);
    expect(elapsed).toBeLessThan(4000);
    expect(authHits).toBe(1);
    expect(providerHits).toBe(0);
    await until(() => server.sockets.size === 0);
  } finally {
    await server.close();
  }
});

import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout as realTimeout, clearTimeout as clearRealTimeout } from "node:timers";
import { ApiSessionOwner } from "./api-session-owner";

afterEach(() => vi.useRealTimers());
async function awaitSocketClose(closed: Promise<void>): Promise<void> {
  let watchdog: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<void>((_, reject) => {
        watchdog = realTimeout(() => reject(new Error("Fixture socket did not close")), 1_000);
      }),
    ]);
  } finally {
    if (watchdog) clearRealTimeout(watchdog);
  }
}

function token(expiresIn: number) {
  return `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresIn })).toString("base64url")}.syntheticSignature`;
}
const session = () => ({ access_token: token(-10), refresh_token: "synthetic-refresh", expires_at: 1, token_type: "bearer", user: { id: "00000000-0000-4000-8000-000000000001" } });

it.each(["body", "retry", "oversize"])("terminates actual SDK %s work, closes the socket and prevents late dispatch", async mode => {
  let dispatches = 0, closed = 0, readyResolve!: () => void, readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let closeResolve!: () => void;
  const socketClosed = new Promise<void>(resolve => { closeResolve = resolve; });
  const server = createServer((req, res) => {
    dispatches++; req.resume(); req.socket.once("close", () => { closed++; closeResolve(); });
    res.writeHead(mode === "retry" ? 503 : 200, { "content-type": "application/json" });
    if (mode === "retry") res.end("{}");
    else if (mode === "oversize") res.write("x".repeat(70_000));
    else res.write(JSON.stringify({ ...session(), access_token: token(3600), expires_in: 3600 }));
    readyResolve();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("fixture listen failed");
  const owner = new ApiSessionOwner();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const result = owner.request({ url: `http://127.0.0.1:${address.port}`, anonKey: "synthetic-anon", cookieName: "synthetic-auth", cookies: [{ name: "synthetic-auth", value: JSON.stringify(session()) }] }).catch(error => { readyReject(error); return error; });
  try {
    await ready;
    if (mode === "oversize") { await awaitSocketClose(socketClosed); expect(closed).toBe(1); }
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await result).toMatchObject({ code: "timeout" });
    await awaitSocketClose(socketClosed); expect(closed).toBe(1);
    await delay(350); expect(dispatches).toBe(1);
  } finally {
    vi.useRealTimers(); await owner.close(); await result;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10_000);

it.each(["success", "rejected", "malformed"])("preserves the canonical SDK %s session and cookie result", async mode => {
  let dispatches = 0, closed = 0;
  const fresh = token(3600);
  let closeResolve!: () => void;
  const socketClosed = new Promise<void>(resolve => { closeResolve = resolve; });
  const server = createServer((req, res) => {
    dispatches++; req.resume(); req.socket.once("close", () => { closed++; closeResolve(); });
    res.writeHead(mode === "rejected" ? 400 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(mode === "success" ? { ...session(), access_token: fresh, refresh_token: "synthetic-rotated", expires_in: 3600 }
      : mode === "malformed" ? { user: session().user }
      : { code: "refresh_token_not_found", message: "Synthetic invalid refresh token" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("fixture listen failed");
  const owner = new ApiSessionOwner();
  try {
    const result = await owner.request({ url: `http://127.0.0.1:${address.port}`, anonKey: "synthetic-anon", cookieName: "synthetic-auth", cookies: [{ name: "synthetic-auth", value: JSON.stringify(session()) }] });
    expect(result).toMatchObject({ accessToken: mode === "success" ? fresh : null,
      cookies: mode === "malformed" ? [] : [{ name: "synthetic-auth", options: { maxAge: mode === "success" ? 34_560_000 : 0 } }] });
    if (mode === "rejected") expect(result).toMatchObject({ error: "rejected", cookies: [{ value: "" }] });
    if (mode === "malformed") expect(result).toMatchObject({ error: "unavailable" });
    await awaitSocketClose(socketClosed);
    expect(dispatches).toBe(1); expect(closed).toBe(1);
  } finally {
    await owner.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10_000);

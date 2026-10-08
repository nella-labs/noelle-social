import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ local: true, session: vi.fn() }));
vi.mock("@/lib/local-auth", () => ({ isLocalAuth: () => fixture.local, localOperatorJwt: () => "synthetic-jwt" }));
vi.mock("@/lib/supabase/api-session", () => ({ getApiSessionAccessToken: fixture.session }));
import { noelleFetch } from "./api";
import { ApiSessionError } from "./supabase/api-session-owner";
beforeEach(() => { fixture.local = true; fixture.session.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("owns a requested read deadline through the complete response body and cancels its reader", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('{"media":[]}')); }, cancel });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
  const request = noelleFetch("/api/content-media/resolve", { method: "POST", body: {}, timeoutMs: 40 }).catch(error => error);
  try {
    await vi.advanceTimersByTimeAsync(80);
    const result = await Promise.race([request, Promise.resolve({ code: "still_pending" })]);
    expect(result).toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalledOnce();
  } finally {
    if (!cancel.mock.calls.length) controller.close();
    await request;
  }
});
it("keeps existing callers without a requested timeout on their original fetch contract", async () => {
  const mock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true })); vi.stubGlobal("fetch", mock);
  expect(await noelleFetch("/api/example")).toEqual({ ok: true });
  expect(new Headers(mock.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer synthetic-jwt");
});
it("forwards the owned opaque Supabase token while the receiving API retains verification", async () => {
  fixture.local = false; fixture.session.mockResolvedValue("synthetic-forwarded-jwt");
  const mock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true })); vi.stubGlobal("fetch", mock);
  expect(await noelleFetch("/api/example")).toEqual({ ok: true });
  expect(new Headers(mock.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer synthetic-forwarded-jwt");
  expect(fixture.session).toHaveBeenCalledWith(8_000);
});
it("subtracts session preparation from a requested complete deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  fixture.local = false;
  fixture.session.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 30)); return "synthetic-jwt"; });
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":true}')); }, cancel });
  const mock = vi.fn(async () => new Response(body)); vi.stubGlobal("fetch", mock);
  const result = noelleFetch("/api/example", { timeoutMs: 40 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(30); expect(mock).toHaveBeenCalledOnce();
  expect(fixture.session).toHaveBeenCalledWith(40);
  await vi.advanceTimersByTimeAsync(10);
  expect(await result).toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalledOnce();
});
it("does not dispatch an API request after session preparation consumes its deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }); fixture.local = false;
  fixture.session.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 41)); return "synthetic-jwt"; });
  const mock = vi.fn(); vi.stubGlobal("fetch", mock);
  const result = noelleFetch("/api/example", { timeoutMs: 40 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(41);
  expect(await result).toMatchObject({ code: "timeout" }); expect(mock).not.toHaveBeenCalled();
});
it("keeps a known absent session unauthorized without dispatching", async () => {
  fixture.local = false; fixture.session.mockResolvedValue(null); const mock = vi.fn(); vi.stubGlobal("fetch", mock);
  await expect(noelleFetch("/api/example")).rejects.toMatchObject({ status: 401, code: "no_session" });
  expect(mock).not.toHaveBeenCalled();
});
it("reports unavailable session preparation without treating it as a sign-out", async () => {
  fixture.local = false; fixture.session.mockRejectedValue(new ApiSessionError("unavailable")); const mock = vi.fn(); vi.stubGlobal("fetch", mock);
  await expect(noelleFetch("/api/example")).rejects.toMatchObject({ status: 503, code: "session_unavailable" });
  expect(mock).not.toHaveBeenCalled();
});
it("preserves the explicit health path without a session read", async () => {
  fixture.local = false; const mock = vi.fn(async () => Response.json({ ok: true })); vi.stubGlobal("fetch", mock);
  expect(await noelleFetch("/health", { skipAuth: true })).toEqual({ ok: true }); expect(fixture.session).not.toHaveBeenCalled();
});

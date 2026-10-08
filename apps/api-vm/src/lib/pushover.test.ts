import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "../env.js";
import { sendPushover } from "./pushover.js";

const args = { title: "Draft ready", message: "A source-bound excerpt" };
const accepted = () => new Response('{"status":1,"request":"accepted-receipt"}');

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NOELLE_DATABASE_URL", "postgres://disabled:disabled@127.0.0.1:1/disabled");
  vi.stubEnv("NOELLE_SUPABASE_JWT_SECRET", "synthetic-jwt-secret");
  vi.stubEnv("NOELLE_HMAC_SECRET", "synthetic-hmac-secret".repeat(3));
  vi.stubEnv("PUSHOVER_USER_KEY", "synthetic-global-user");
  vi.stubEnv("PUSHOVER_APP_TOKEN", "synthetic-global-token");
  resetEnvForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe("API Pushover acceptance", () => {
  it.each(['{"status":0,"errors":["rejected"]}', "not JSON", '{"status":1,"request":" "}'])(
    "does not acknowledge an unusable HTTP 200 receipt: %s", async (body) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body));
      vi.stubGlobal("fetch", fetchImpl);
      expect(await sendPushover(args)).toEqual({ ok: false, reason: "pushover_not_accepted" });
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("bounds an unfinished response body by the original five-second deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"status":')); },
      cancel,
    }));
    const fetchImpl = vi.fn<typeof fetch>(async () => response);
    vi.stubGlobal("fetch", fetchImpl);
    const pending = sendPushover(args);
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toEqual({ ok: false, reason: "pushover_not_accepted" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      await pending;
      if (!response.bodyUsed) await response.body?.cancel();
    }
  });

  it("clears a failed transport deadline and hides exception content", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("private-token-in-transport-error"); });
    vi.stubGlobal("fetch", fetchImpl);
    const result = await sendPushover(args);
    expect(vi.getTimerCount()).toBe(0);
    expect(result).toEqual({ ok: false, reason: "pushover_not_accepted" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("aborts held headers once and admits a later healthy notification", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })).mockImplementationOnce(async () => accepted());
    vi.stubGlobal("fetch", fetchImpl);
    const pending = sendPushover(args);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchImpl.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).ok).toBe(false);
    expect(fetchImpl.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(await sendPushover(args)).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([" ".repeat(65_537), "😀".repeat(16_385)])("bounds actual response bytes", async (padding) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ status: 1, request: "accepted", padding }),
    ));
    vi.stubGlobal("fetch", fetchImpl);
    expect(await sendPushover(args)).toEqual({ ok: false, reason: "pushover_not_accepted" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("maps global credentials and arguments through canonical field limits", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => accepted());
    vi.stubGlobal("fetch", fetchImpl);
    expect(await sendPushover({ title: "t".repeat(251), message: "m".repeat(1025),
      url: "https://console.invalid/approvals/one", urlTitle: "u".repeat(101), priority: -1 })).toEqual({ ok: true });
    const body = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(Object.fromEntries(body)).toEqual({ user: "synthetic-global-user", token: "synthetic-global-token",
      title: "t".repeat(250), message: "m".repeat(1024), url: "https://console.invalid/approvals/one",
      url_title: "u".repeat(100), priority: "-1" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("preserves valid acceptance, default priority and absent optional fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => accepted());
    vi.stubGlobal("fetch", fetchImpl);
    expect(await sendPushover(args)).toEqual({ ok: true });
    const body = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(body.get("priority")).toBe("0");
    expect(body.has("url")).toBe(false);
    expect(body.has("url_title")).toBe(false);
  });

  it("retains a safe non-success HTTP status", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("private error body", { status: 503 })));
    expect(await sendPushover(args)).toEqual({ ok: false, reason: "pushover_http_503" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["PUSHOVER_USER_KEY", "PUSHOVER_APP_TOKEN"])("does not dispatch without %s", async (key) => {
    vi.stubEnv(key, "");
    resetEnvForTests();
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);
    expect(await sendPushover(args)).toEqual({ ok: false, reason: "pushover_not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

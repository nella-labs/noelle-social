// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPanel } from "./panel.js";

const originalAttachShadow = Element.prototype.attachShadow;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("browser discovery actor control", () => {
  it("re-enables cap editing when the extension loses a save reply", async () => {
    vi.useFakeTimers();
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
      return originalAttachShadow.call(this, { ...init, mode: "open" });
    });
    let reads = 0;
    let finishRead!: (value: unknown) => void;
    const lateRead = new Promise<unknown>((resolve) => { finishRead = resolve; });
    const sendMessage = vi.fn(async (message: { cmd: string }) => {
      if (message.cmd === "getReplyCap") {
        reads++;
        return reads === 1 ? { ok: true, cap: { sent: 5, cap: 80, remaining: 75 } } : lateRead;
      }
      if (message.cmd === "setReplyCap") return new Promise<never>(() => {});
      return { ok: true };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage }, storage: { local: {
      get: vi.fn(async () => ({})), set: vi.fn(async () => {}),
    } } });
    mountPanel();
    await vi.advanceTimersByTimeAsync(0);
    const panel = document.body.firstElementChild!.shadowRoot!;
    expect(panel.querySelector("#na-replies")?.textContent).toBe("5/80");
    await vi.advanceTimersByTimeAsync(14_900);
    (panel.querySelector("#na-cap-input") as HTMLInputElement).value = "79";
    const save = panel.querySelector<HTMLButtonElement>("#na-cap-save")!;
    save.click();
    expect(save.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(7_900);
    expect(save.disabled).toBe(false);
    expect(panel.querySelector("#na-cap-status")?.textContent).toContain("timed out");
    finishRead({ ok: true, cap: { sent: 5, cap: 80, remaining: 75 } });
    await Promise.resolve();
    expect(panel.querySelector("#na-cap-status")?.textContent).toContain("timed out");
    expect(panel.querySelector("#na-replies")?.textContent).toBe("5/80");
  });

  it("does not let an older cap poll replace a saved cap", async () => {
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
      return originalAttachShadow.call(this, { ...init, mode: "open" });
    });
    let finishRead!: (value: unknown) => void;
    const oldRead = new Promise<unknown>((resolve) => { finishRead = resolve; });
    const sendMessage = vi.fn(async (message: { cmd: string }) => {
      if (message.cmd === "getReplyCap") return oldRead;
      if (message.cmd === "setReplyCap") return { ok: true, cap: { sent: 20, cap: 80, remaining: 60 } };
      return { ok: true };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage }, storage: { local: {
      get: vi.fn(async () => ({})), set: vi.fn(async () => {}),
    } } });
    mountPanel();
    const panel = document.body.firstElementChild!.shadowRoot!;
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ cmd: "getReplyCap" }));
    (panel.querySelector("#na-cap-input") as HTMLInputElement).value = "80";
    panel.querySelector<HTMLButtonElement>("#na-cap-save")!.click();
    await vi.waitFor(() => expect(panel.querySelector("#na-replies")?.textContent).toBe("20/80"));
    finishRead({ ok: true, cap: { sent: 20, cap: 90, remaining: 70 } });
    await Promise.resolve();
    expect(panel.querySelector("#na-replies")?.textContent).toBe("20/80");
  });

  it("shows confirmed replies separately from leads and saves the server cap", async () => {
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
      return originalAttachShadow.call(this, { ...init, mode: "open" });
    });
    const sendMessage = vi.fn(async (message: { cmd: string; cap?: number }) => {
      if (message.cmd === "getReplyCap") return { ok: true, cap: { sent: 20, cap: 80, remaining: 60 } };
      if (message.cmd === "setReplyCap") return { ok: true, cap: { sent: 20, cap: message.cap, remaining: 100 - 20 } };
      return { ok: true };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage }, storage: { local: {
      get: vi.fn(async () => ({})), set: vi.fn(async () => {}),
    } } });
    mountPanel();
    const panel = document.body.firstElementChild!.shadowRoot!;
    await vi.waitFor(() => expect(panel.querySelector("#na-replies")?.textContent).toBe("20/80"));
    expect(panel.querySelector("#na-remaining")?.textContent).toBe("60 left today");
    expect(panel.querySelector("#na-leads")?.textContent).toBe("0/5");
    (panel.querySelector("#na-cap-input") as HTMLInputElement).value = "100";
    panel.querySelector<HTMLButtonElement>("#na-cap-save")!.click();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ cmd: "setReplyCap", cap: 100 }));
    await vi.waitFor(() => expect(panel.querySelector("#na-replies")?.textContent).toBe("20/100"));
  });

  it("starts discovery from a visible button and reports its active state", async () => {
    vi.useFakeTimers();
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
      return originalAttachShadow.call(this, { ...init, mode: "open" });
    });
    const sendMessage = vi.fn(async ({ cmd }: { cmd: string }) => {
      if (cmd === "getState") return {
        ok: true,
        browserDiscoveryActive: true,
        browserDiscoveryStatus: { result: "submitted", observed: 3, accepted: 2 },
        state: { status: "running", commentPool: [{}, {}], actions: [], lastEvent: "reading feed" },
      };
      return { ok: true };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage }, storage: { local: {
      get: vi.fn(async () => ({})), set: vi.fn(async () => {}),
    } } });

    mountPanel();
    const panel = document.body.firstElementChild!.shadowRoot!;
    const button = [...panel.querySelectorAll("button")].find((item) => item.textContent?.includes("Discover + reply automatically"));
    expect(button).toBeDefined();
    await vi.waitFor(() => expect(button!.disabled).toBe(false));
    button!.click();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ cmd: "startBrowserDiscovery" }));

    await vi.advanceTimersByTimeAsync(4_000);
    expect(panel.textContent).toContain("Discovery active");
    expect(panel.querySelector("#na-leads")?.textContent).toBe("2/5");

    panel.querySelector<HTMLButtonElement>("#na-stop")!.click();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ cmd: "stopRun" }));
    expect(panel.textContent).toContain("Discovery off");
  });

  it("shows a current post-link failure while observation and the run continue", async () => {
    vi.useFakeTimers();
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
      return originalAttachShadow.call(this, { ...init, mode: "open" });
    });
    let identityResult = "unresolved";
    let discoveryActive = true;
    let observationAt = new Date(Date.now() - 1_000).toISOString();
    const identityAt = new Date().toISOString();
    const sendMessage = vi.fn(async ({ cmd }: { cmd: string }) => {
      if (cmd === "getDiscoveryCapacity") return { ok: true, capacity: { occupied: 0, available: 5, limit: 5 } };
      if (cmd === "getReplyCap") return { ok: true, cap: { sent: 0, cap: 80, remaining: 80 } };
      if (cmd === "getState") return {
        ok: true, browserDiscoveryActive: discoveryActive,
        browserDiscoveryStatus: { result: "submitted", observed: 1, accepted: 1, at: observationAt },
        browserDiscoveryIdentityStatus: { result: identityResult, reason: "embed-link-not-found", at: identityAt },
        state: { status: "running", commentPool: [], actions: [], lastEvent: "reading feed" },
      };
      return { ok: true };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage }, storage: { local: {
      get: vi.fn(async () => ({})), set: vi.fn(async () => {}),
    } } });
    mountPanel();
    const panel = document.body.firstElementChild!.shadowRoot!;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(panel.querySelector("#na-discovery-status")?.textContent).toBe("Discovery active");
    expect(panel.querySelector("#na-error")?.textContent).toContain("Post link unavailable: embed-link-not-found");
    discoveryActive = false;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(panel.querySelector("#na-error")?.textContent).toBe("");
    discoveryActive = true;
    observationAt = new Date().toISOString();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(panel.querySelector("#na-error")?.textContent).toBe("");
    identityResult = "resolved";
    await vi.advanceTimersByTimeAsync(4_000);
    expect(panel.querySelector("#na-error")?.textContent).toBe("");
  });

  it("saves an optional quiet window and applies it before starting discovery", async () => {
    vi.useFakeTimers();
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
      return originalAttachShadow.call(this, { ...init, mode: "open" });
    });
    const values: Record<string, unknown> = {
      "noelle.discoverySchedule.v1": { enabled: true, start: "02:30", end: "08:15" },
    };
    const get = vi.fn(async (key: string) => ({ [key]: values[key] }));
    const set = vi.fn(async (patch: Record<string, unknown>) => { Object.assign(values, patch); });
    const sendMessage = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("chrome", { runtime: { sendMessage }, storage: { local: { get, set } } });

    mountPanel();
    const panel = document.body.firstElementChild!.shadowRoot!;
    await vi.waitFor(() => expect(panel.querySelector<HTMLInputElement>("#na-discovery-quiet")!.checked).toBe(true));
    expect(panel.querySelector<HTMLInputElement>("#na-discovery-start")!.value).toBe("02:30");
    expect(panel.querySelector<HTMLInputElement>("#na-discovery-end")!.value).toBe("08:15");
    const start = panel.querySelector<HTMLInputElement>("#na-discovery-start")!;
    start.value = "03:00";
    start.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(set).toHaveBeenCalledWith({
      "noelle.discoverySchedule.v1": { enabled: true, start: "03:00", end: "08:15" },
    }));

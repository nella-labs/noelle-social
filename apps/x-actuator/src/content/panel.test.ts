// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPanel } from "./panel.js";

const originalAttachShadow = Element.prototype.attachShadow;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("X actor panel", () => {
  it("edits the ceiling and daily range while counting today's effective cap", async () => {
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
      return originalAttachShadow.call(this, { ...init, mode: "open" });
    });
    const sendMessage = vi.fn(async (message: { cmd: string; cap?: number; minimum?: number | null }) => {
      if (message.cmd === "getReplyCap" || message.cmd === "setReplyCap") return { ok: true, cap: {
        sent: 7, cap: 103, remaining: 96, configuredCap: 140, minimum: 80, day: "2026-10-07",
      } };
      if (message.cmd === "getDiscoveryCapacity") return { ok: true, capacity: { occupied: 4, limit: 5, available: 1 } };
      return { ok: true };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage }, storage: { local: {
      get: vi.fn(async () => ({})), set: vi.fn(async () => {}),
    } } });
    mountPanel();
    const panel = document.body.firstElementChild!.shadowRoot!;
    await vi.waitFor(() => expect(panel.querySelector("#na-replies")?.textContent).toBe("7/103"));
    expect((panel.querySelector("#na-cap-input") as HTMLInputElement).value).toBe("140");
    expect((panel.querySelector("#na-cap-vary") as HTMLInputElement)?.checked).toBe(true);
    expect((panel.querySelector("#na-cap-minimum") as HTMLInputElement)?.value).toBe("80");
    expect(panel.querySelector("#na-cap-summary")?.textContent).toContain("80–140");
    panel.querySelector<HTMLButtonElement>("#na-cap-save")!.click();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ cmd: "setReplyCap", cap: 140, minimum: 80 }));
    expect(panel.querySelector("#na-leads")?.textContent).toBe("4/5");
  });

  it("preserves unsaved cap and policy edits across status polling", async () => {
    vi.useFakeTimers();
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
      return originalAttachShadow.call(this, { ...init, mode: "open" });
    });
    const sendMessage = vi.fn(async ({ cmd }: { cmd: string }) => cmd === "getReplyCap"
      ? { ok: true, cap: { sent: 7, cap: 103, remaining: 96, configuredCap: 140, minimum: 80, day: "2026-10-07" } }
      : cmd === "getDiscoveryCapacity" ? { ok: true, capacity: { occupied: 0, limit: 5, available: 5 } } : { ok: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage }, storage: { local: {
      get: vi.fn(async () => ({})), set: vi.fn(async () => {}),
    } } });
    mountPanel();
    const panel = document.body.firstElementChild!.shadowRoot!;
    await vi.waitFor(() => expect(panel.querySelector("#na-replies")?.textContent).toBe("7/103"));
    const ceiling = panel.querySelector<HTMLInputElement>("#na-cap-input")!;
    ceiling.value = "130";
    ceiling.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ceiling.value).toBe("130");
    const minimum = panel.querySelector<HTMLInputElement>("#na-cap-minimum")!;
    minimum.value = "90";
    minimum.dispatchEvent(new Event("input", { bubbles: true }));
    const vary = panel.querySelector<HTMLInputElement>("#na-cap-vary")!;
    vary.checked = false;
    vary.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ceiling.value).toBe("130");
    expect(minimum.value).toBe("90");
    expect(vary.checked).toBe(false);
  });

  it("disables daily variation by saving the configured ceiling as a fixed cap", async () => {
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
      return originalAttachShadow.call(this, { ...init, mode: "open" });
    });
    const sendMessage = vi.fn(async (message: { cmd: string; cap?: number }) => {
      if (message.cmd === "getReplyCap") return { ok: true, cap: {
        sent: 7, cap: 103, remaining: 96, configuredCap: 140, minimum: 80, day: "2026-10-07",
      } };
      if (message.cmd === "setReplyCap") return { ok: true, cap: { sent: 7, cap: 140, remaining: 133 } };
      if (message.cmd === "getDiscoveryCapacity") return { ok: true, capacity: { occupied: 0, limit: 5, available: 5 } };
      return { ok: true };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage }, storage: { local: {
      get: vi.fn(async () => ({})), set: vi.fn(async () => {}),
    } } });
    mountPanel();
    const panel = document.body.firstElementChild!.shadowRoot!;
    await vi.waitFor(() => expect(panel.querySelector("#na-replies")?.textContent).toBe("7/103"));
    const vary = panel.querySelector<HTMLInputElement>("#na-cap-vary")!;
    expect(vary).not.toBeNull();
    vary.checked = false;
    vary.dispatchEvent(new Event("change", { bubbles: true }));
    panel.querySelector<HTMLButtonElement>("#na-cap-save")!.click();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ cmd: "setReplyCap", cap: 140 }));
    await vi.waitFor(() => expect(panel.querySelector("#na-replies")?.textContent).toBe("7/140"));
    expect(panel.querySelector("#na-cap-summary")?.textContent).toBe("140");
  });

  it("holds a minimum above the ceiling before requesting a save", async () => {
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
      return originalAttachShadow.call(this, { ...init, mode: "open" });
    });
    const sendMessage = vi.fn(async ({ cmd }: { cmd: string }) => cmd === "getReplyCap"
      ? { ok: true, cap: { sent: 7, cap: 140, remaining: 133 } }
      : cmd === "getDiscoveryCapacity" ? { ok: true, capacity: { occupied: 0, limit: 5, available: 5 } } : { ok: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage }, storage: { local: {
      get: vi.fn(async () => ({})), set: vi.fn(async () => {}),
    } } });
    mountPanel();
    const panel = document.body.firstElementChild!.shadowRoot!;
    await vi.waitFor(() => expect(panel.querySelector("#na-replies")?.textContent).toBe("7/140"));
    const vary = panel.querySelector<HTMLInputElement>("#na-cap-vary")!;
    expect(vary).not.toBeNull();
    vary.checked = true;
    vary.dispatchEvent(new Event("change", { bubbles: true }));
    panel.querySelector<HTMLInputElement>("#na-cap-minimum")!.value = "141";
    panel.querySelector<HTMLButtonElement>("#na-cap-save")!.click();
    expect(panel.querySelector("#na-cap-status")?.textContent).toContain("minimum");
    expect(sendMessage.mock.calls.some(([message]) => message.cmd === "setReplyCap")).toBe(false);
  });

  it("shows the browser reply cap and updates it without changing the discovery pool", async () => {
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
      return originalAttachShadow.call(this, { ...init, mode: "open" });
    });
    const sendMessage = vi.fn(async (message: { cmd: string; cap?: number }) => {
      if (message.cmd === "getReplyCap") return { ok: true, cap: { sent: 7, cap: 90, remaining: 83 } };
      if (message.cmd === "setReplyCap") return { ok: true, cap: { sent: 7, cap: message.cap, remaining: 73 } };
      if (message.cmd === "getDiscoveryCapacity") return { ok: true, capacity: { occupied: 4, limit: 5, available: 1 } };
      return { ok: true };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage }, storage: { local: {
      get: vi.fn(async () => ({})), set: vi.fn(async () => {}),
    } } });
    mountPanel();
    const panel = document.body.firstElementChild!.shadowRoot!;
    await vi.waitFor(() => expect(panel.querySelector("#na-replies")?.textContent).toBe("7/90"));
    await vi.waitFor(() => expect(panel.querySelector("#na-leads")?.textContent).toBe("4/5"));
    (panel.querySelector("#na-cap-input") as HTMLInputElement).value = "80";
    panel.querySelector<HTMLButtonElement>("#na-cap-save")!.click();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ cmd: "setReplyCap", cap: 80 }));
    await vi.waitFor(() => expect(panel.querySelector("#na-replies")?.textContent).toBe("7/80"));
    expect(panel.querySelector("#na-leads")?.textContent).toBe("4/5");
  });

  it("shows the same compact controls, ready count, and error alert", async () => {
    vi.useFakeTimers();
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
      return originalAttachShadow.call(this, { ...init, mode: "open" });
    });
    const sendMessage = vi.fn(async ({ cmd }: { cmd: string }) => cmd === "getDiscoveryCapacity"
      ? { ok: true, capacity: { occupied: 3, available: 2, limit: 5 } }
      : cmd === "getState" ? { ok: true, discoveryActive: true, state: {
          status: "halted-challenge", commentPool: [{}, {}], actions: [], lastEvent: "challenge detected",
        } }
      : { ok: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage }, storage: { local: {
      get: vi.fn(async () => ({})), set: vi.fn(async () => {}),
    } } });

    mountPanel();
    const panel = document.body.firstElementChild!.shadowRoot!;
    expect(panel.querySelector<HTMLButtonElement>("#na-discover")?.textContent).toContain("Discover + reply automatically");
    await vi.waitFor(() => expect(panel.querySelector("#na-leads")?.textContent).toBe("3/5"));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(panel.querySelector("#na-leads")?.textContent).toBe("3/5");
    expect(panel.querySelector("#na-error")?.textContent).toContain("challenge detected");
    expect(panel.querySelector("#na-error")?.getAttribute("role")).toBe("alert");
    expect(panel.querySelector("pre")).toBeNull();
    expect(panel.querySelector("#na-advanced")?.hasAttribute("open")).toBe(false);
    expect(panel.querySelector("#na-schedule")?.hasAttribute("open")).toBe(false);
  });
});

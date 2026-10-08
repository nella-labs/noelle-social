// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISCOVERY_SCHEDULE_KEY } from "@noelle/actuator-cdp";
import { mountPanel } from "../src/content/panel.js";

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function panelWithStorage(storage: { get: () => Promise<unknown>; set: (value: unknown) => Promise<void> }) {
  const commands: string[] = [];
  vi.stubGlobal("chrome", {
    storage: { local: storage },
    runtime: { sendMessage: async ({ cmd }: { cmd: string }) => { commands.push(cmd); return { ok: true }; } },
  });
  const nativeAttach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element) {
    return nativeAttach.call(this, { mode: "open" });
  });
  mountPanel();
  const root = document.body.firstElementChild?.shadowRoot;
  expect(root).toBeTruthy();
  return { root: root!, commands };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("X discovery schedule controls", () => {
  it("waits for every queued schedule edit before starting discovery", async () => {
    vi.useFakeTimers();
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = new Promise<void>((resolve) => { finishFirst = resolve; });
    const second = new Promise<void>((resolve) => { finishSecond = resolve; });
    const set = vi.fn().mockImplementationOnce(() => first).mockImplementationOnce(() => second);
    const { root, commands } = panelWithStorage({
      get: async () => ({ [DISCOVERY_SCHEDULE_KEY]: { enabled: true, start: "02:00", end: "08:00" } }),
      set,
    });
    await flush();
    const start = root.querySelector<HTMLInputElement>("#na-discovery-start")!;
    const end = root.querySelector<HTMLInputElement>("#na-discovery-end")!;
    start.value = "01:00";
    start.dispatchEvent(new Event("change"));
    end.value = "09:00";
    end.dispatchEvent(new Event("change"));
    root.querySelector<HTMLButtonElement>("#na-discover")!.click();
    await flush();
    expect(set).toHaveBeenCalledTimes(1); // saves are serialized
    expect(commands).not.toContain("startDiscovery");
    finishFirst();
    await flush();
    expect(set).toHaveBeenCalledTimes(2);
    expect(commands).not.toContain("startDiscovery");
    finishSecond();
    await flush();
    expect(commands).toContain("startDiscovery");
    expect(set.mock.calls[1]![0]).toEqual({ [DISCOVERY_SCHEDULE_KEY]: { enabled: true, start: "01:00", end: "09:00" } });
  });

  it("does not start discovery when the latest schedule save fails", async () => {
    vi.useFakeTimers();
    const { root, commands } = panelWithStorage({
      get: async () => ({ [DISCOVERY_SCHEDULE_KEY]: { enabled: false, start: "01:00", end: "09:00" } }),
      set: async () => { throw new Error("storage failed"); },
    });
    await flush();
    const enabled = root.querySelector<HTMLInputElement>("#na-discovery-quiet")!;
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change"));
    root.querySelector<HTMLButtonElement>("#na-discover")!.click();
    await flush();
    expect(commands).not.toContain("startDiscovery");
    expect(root.querySelector("#na-error")!.textContent).toContain("storage failed");
  });

  it("does not start discovery when initial schedule storage cannot be read", async () => {
    vi.useFakeTimers();
    const { root, commands } = panelWithStorage({
      get: async () => { throw new Error("storage unavailable"); },
      set: async () => undefined,
    });
    root.querySelector<HTMLButtonElement>("#na-discover")!.click();
    await flush();
    expect(commands).not.toContain("startDiscovery");
    expect(root.querySelector("#na-error")!.textContent).toContain("storage unavailable");
  });

  it("loads the saved local window, persists edits, and starts discovery without resetting it", async () => {
    vi.useFakeTimers();
    const saved = { enabled: true, start: "02:15", end: "07:45" };
    const writes: unknown[] = [];
    const commands: string[] = [];
    vi.stubGlobal("chrome", {
      storage: { local: {
        get: async () => ({ [DISCOVERY_SCHEDULE_KEY]: saved }),
        set: async (value: unknown) => { writes.push(value); },
      } },
      runtime: { sendMessage: async ({ cmd }: { cmd: string }) => { commands.push(cmd); return { ok: true }; } },
    });
    const nativeAttach = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element) {
      return nativeAttach.call(this, { mode: "open" });
    });

    mountPanel();
    await Promise.resolve();
    const root = document.body.firstElementChild?.shadowRoot;
    expect(root).toBeTruthy();
    const enabled = root!.querySelector<HTMLInputElement>("#na-discovery-quiet")!;
    const start = root!.querySelector<HTMLInputElement>("#na-discovery-start")!;
    const end = root!.querySelector<HTMLInputElement>("#na-discovery-end")!;
    expect([enabled.checked, start.value, end.value]).toEqual([true, "02:15", "07:45"]);

    start.value = "01:00";
    start.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(writes.at(-1)).toEqual({ [DISCOVERY_SCHEDULE_KEY]: { enabled: true, start: "01:00", end: "07:45" } });

    enabled.checked = false;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(writes.at(-1)).toEqual({ [DISCOVERY_SCHEDULE_KEY]: { enabled: false, start: "01:00", end: "07:45" } });
    root!.querySelector<HTMLButtonElement>("#na-discover")!.click();
    await flush();
    expect(commands).toContain("startDiscovery");
    expect(writes.at(-1)).toEqual({ [DISCOVERY_SCHEDULE_KEY]: { enabled: false, start: "01:00", end: "07:45" } });
  });
});

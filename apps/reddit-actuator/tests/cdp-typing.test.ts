import { describe, it, expect, beforeEach } from "vitest";
import { Cdp } from "../src/background/cdp.js";
import { makeRng } from "../src/lib/rng.js";

// The typeText keystroke stream (ports #444): per mappable char the actuator
// sends a TEXT-LESS rawKeyDown (keystroke telemetry only, real key/code/keyCode)
// → Input.insertText (the framework-observable edit that makes the editor model
// sync, so the submit enables) → keyUp. The old keyDown-with-text path produced
// a native edit Reddit's framework composer could ignore, leaving the submit
// disabled forever.

type Call = { method: string; params: Record<string, unknown> };
const calls: Call[] = [];

// Minimal chrome.debugger stub — Cdp only touches sendCommand here.
(globalThis as { chrome?: unknown }).chrome = {
  debugger: {
    sendCommand: (_target: unknown, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return Promise.resolve();
    },
  },
} as unknown as typeof chrome;

const noSleep = async (_ms: number) => {};

beforeEach(() => {
  calls.length = 0;
});

describe("Cdp.typeText — insertText-committed keystrokes (ports #444)", () => {
  it("per mappable char: text-less rawKeyDown → Input.insertText → keyUp", async () => {
    await new Cdp().typeText(1, "hi", makeRng(7), noSleep);
    const keys = calls.filter((c) => c.method === "Input.dispatchKeyEvent");
    // NO keyDown-with-text anywhere — that was the native-edit path the
    // framework editor ignores.
    expect(keys.some((c) => c.params.type === "keyDown")).toBe(false);
    expect(keys.every((c) => c.params.text === undefined)).toBe(true);
    // Every char is committed via Input.insertText, in order.
    expect(calls.filter((c) => c.method === "Input.insertText").map((c) => c.params.text)).toEqual(["h", "i"]);
    // Per-char ordering: rawKeyDown precedes its insertText precedes its keyUp.
    const seq = calls.map((c) =>
      c.method === "Input.insertText" ? `ins:${c.params.text}` : `${c.params.type}:${c.params.key}`,
    );
    expect(seq).toEqual(["rawKeyDown:h", "ins:h", "keyUp:h", "rawKeyDown:i", "ins:i", "keyUp:i"]);
  });

  it("keystroke telemetry keeps real US-keyboard metadata on the rawKeyDown", async () => {
    await new Cdp().typeText(1, "a", makeRng(3), noSleep);
    const down = calls.find((c) => c.method === "Input.dispatchKeyEvent" && c.params.type === "rawKeyDown")!;
    expect(down.params).toMatchObject({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
  });

  it("Shift is held across consecutive shifted chars (telemetry stream preserved)", async () => {
    await new Cdp().typeText(1, "Hi", makeRng(5), noSleep);
    const keys = calls.filter((c) => c.method === "Input.dispatchKeyEvent");
    const shiftDowns = keys.filter((c) => c.params.key === "Shift" && c.params.type === "rawKeyDown");
    expect(shiftDowns).toHaveLength(1); // held for 'H', released before 'i'
    // 'H' rides modifiers=8 (shift), 'i' rides modifiers=0.
    const h = keys.find((c) => c.params.type === "rawKeyDown" && c.params.key === "H")!;
    const i = keys.find((c) => c.params.type === "rawKeyDown" && c.params.key === "i")!;
    expect(h.params.modifiers).toBe(8);
    expect(i.params.modifiers).toBe(0);
    // The characters themselves still land via insertText.
    expect(calls.filter((c) => c.method === "Input.insertText").map((c) => c.params.text)).toEqual(["H", "i"]);
  });

  it("unmappable chars (emoji/newline) are committed via Input.insertText alone", async () => {
    await new Cdp().typeText(1, "a🦊", makeRng(9), noSleep);
    const inserts = calls.filter((c) => c.method === "Input.insertText").map((c) => c.params.text);
    expect(inserts).toEqual(["a", "🦊"]);
    // No synthetic key events for the emoji.
    const keys = calls.filter((c) => c.method === "Input.dispatchKeyEvent" && c.params.key !== "Shift");
    expect(keys.map((c) => c.params.key)).toEqual(["a", "a"]); // rawKeyDown + keyUp for 'a' only
  });
});

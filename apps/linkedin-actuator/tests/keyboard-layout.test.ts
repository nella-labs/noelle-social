import { describe, it, expect } from "vitest";
import { keyStrokeFor } from "../src/lib/keyboard-layout.js";

describe("keyboard-layout", () => {
  it("maps lowercase and uppercase letters to the same physical key", () => {
    expect(keyStrokeFor("a")).toEqual({ code: "KeyA", keyCode: 65, key: "a", unmodified: "a", shift: false });
    expect(keyStrokeFor("A")).toEqual({ code: "KeyA", keyCode: 65, key: "A", unmodified: "a", shift: true });
    expect(keyStrokeFor("z")).toMatchObject({ code: "KeyZ", keyCode: 90, shift: false });
    expect(keyStrokeFor("Z")).toMatchObject({ code: "KeyZ", keyCode: 90, shift: true });
  });

  it("maps digits and their shifted symbols to the same key", () => {
    expect(keyStrokeFor("1")).toMatchObject({ code: "Digit1", keyCode: 49, shift: false });
    expect(keyStrokeFor("!")).toMatchObject({ code: "Digit1", keyCode: 49, unmodified: "1", shift: true });
    expect(keyStrokeFor("2")).toMatchObject({ code: "Digit2", keyCode: 50, shift: false });
    expect(keyStrokeFor("@")).toMatchObject({ code: "Digit2", keyCode: 50, unmodified: "2", shift: true });
  });

  it("maps space and the punctuation replies actually use", () => {
    expect(keyStrokeFor(" ")).toMatchObject({ code: "Space", keyCode: 32, shift: false });
    expect(keyStrokeFor(",")).toMatchObject({ code: "Comma", keyCode: 188, shift: false });
    expect(keyStrokeFor(".")).toMatchObject({ code: "Period", keyCode: 190, shift: false });
    expect(keyStrokeFor("?")).toMatchObject({ code: "Slash", keyCode: 191, unmodified: "/", shift: true });
    expect(keyStrokeFor("'")).toMatchObject({ code: "Quote", keyCode: 222, shift: false });
    expect(keyStrokeFor('"')).toMatchObject({ code: "Quote", keyCode: 222, shift: true });
    expect(keyStrokeFor("-")).toMatchObject({ code: "Minus", keyCode: 189, shift: false });
  });

  it("returns undefined for characters with no single-key US mapping", () => {
    // These are inserted via Input.insertText, not a synthetic key.
    expect(keyStrokeFor("é")).toBeUndefined();
    expect(keyStrokeFor("🙂")).toBeUndefined();
    expect(keyStrokeFor("\n")).toBeUndefined();
    expect(keyStrokeFor("\t")).toBeUndefined();
  });

  it("never yields keyCode 0 or an empty code for any printable ASCII (the automation tell it fixes)", () => {
    for (let cp = 0x20; cp <= 0x7e; cp++) {
      const ch = String.fromCharCode(cp);
      const def = keyStrokeFor(ch);
      expect(def, `char ${JSON.stringify(ch)} (0x${cp.toString(16)}) should map to a real key`).toBeDefined();
      expect(def!.keyCode).toBeGreaterThan(0);
      expect(def!.code).not.toBe("");
      expect(def!.key).toBe(ch);
    }
  });
});

import { describe, expect, it } from "vitest";
import { createSourceCursorRegistry } from "./source-cursor.js";

describe("createSourceCursorRegistry", () => {
  it("keys cursors by instance AND mode — a watchlist tick can't clamp the full-mode cursor", () => {
    const reg = createSourceCursorRegistry();
    reg.for("i", "full").set(30);
    reg.for("i", "watchlist").set(0);
    expect(reg.for("i", "full").get()).toBe(30);
    expect(reg.for("i", "watchlist").get()).toBe(0);
  });

  it("isolates instances from each other", () => {
    const reg = createSourceCursorRegistry();
    reg.for("i", "full").set(5);
    expect(reg.for("j", "full").get()).toBe(0);
    expect(reg.for("i", "full").get()).toBe(5);
  });

  it("defaults to the ring head", () => {
    expect(createSourceCursorRegistry().for("i", "full").get()).toBe(0);
  });
});

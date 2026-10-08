import { describe, it, expect } from "vitest";
import { withinSendWindow, sendWindowConfigured, sendWindowValid, resolveSendWindow } from "./send-window.js";

// Fixed instant: 2026-07-09T10:00:00Z. With tz=-300 (UTC-5) local hour = 05:00.
const T = Date.parse("2026-07-09T10:00:00Z");

describe("withinSendWindow", () => {
  it("start===end disables the gate (always open, incl. default 0,0)", () => {
    expect(withinSendWindow(T, 0, 0, -300)).toBe(true);
    expect(withinSendWindow(T, 8, 8, -300)).toBe(true);
  });
  it("blocks when local hour is before the window (05:00 local, window 08-20)", () => {
    expect(withinSendWindow(T, 8, 20, -300)).toBe(false);
  });
  it("allows when local hour is inside the window", () => {
    // 2026-07-09T18:00:00Z, tz -300 => 13:00 local, inside 08-20
    expect(withinSendWindow(Date.parse("2026-07-09T18:00:00Z"), 8, 20, -300)).toBe(true);
  });
  it("excludes the end hour (exclusive upper bound)", () => {
    // 20:00 local exactly -> outside [8,20)
    expect(withinSendWindow(Date.parse("2026-07-10T01:00:00Z"), 8, 20, -300)).toBe(false);
  });
  it("handles a window that wraps past midnight (22->6)", () => {
    // 23:00 local
    expect(withinSendWindow(Date.parse("2026-07-10T04:00:00Z"), 22, 6, -300)).toBe(true);
    // 12:00 local -> outside
    expect(withinSendWindow(Date.parse("2026-07-09T17:00:00Z"), 22, 6, -300)).toBe(false);
  });
});

describe("sendWindowConfigured", () => {
  it("false when both unset/empty (default => no behavior change)", () => {
    expect(sendWindowConfigured(undefined, undefined)).toBe(false);
    expect(sendWindowConfigured("", "")).toBe(false);
  });
  it("true when either is set", () => {
    expect(sendWindowConfigured("8", undefined)).toBe(true);
    expect(sendWindowConfigured(undefined, "20")).toBe(true);
  });
});

describe("sendWindowValid (fail-closed guard)", () => {
  it("accepts a sane window", () => {
    expect(sendWindowValid(8, 20, -300)).toBe(true);
  });
  it("rejects NaN / out-of-range so the route fails closed", () => {
    expect(sendWindowValid(NaN, 20, -300)).toBe(false);
    expect(sendWindowValid(8, 25, -300)).toBe(false);
    expect(sendWindowValid(-1, 20, -300)).toBe(false);
    expect(sendWindowValid(8, 20, NaN)).toBe(false);
  });
  it("rejects a non-numeric bound (Number('abc') === NaN)", () => {
    expect(sendWindowValid(8, Number("abc"), -300)).toBe(false);
  });
});

describe("resolveSendWindow (partial-config fail-closed)", () => {
  it("both unset => not configured (24h open, no behavior change)", () => {
    const r = resolveSendWindow(undefined, undefined, undefined);
    expect(r.configured).toBe(false);
  });
  it("both set => configured + valid, uses default tz when tz unset", () => {
    const r = resolveSendWindow("8", "20", undefined);
    expect(r).toMatchObject({ configured: true, valid: true, startHour: 8, endHour: 20, tzOffsetMin: -300 });
  });
  it("START set, END UNSET => configured but INVALID (end=NaN) => caller fails closed", () => {
    const r = resolveSendWindow("8", undefined, "-300");
    expect(r.configured).toBe(true);
    expect(Number.isNaN(r.endHour)).toBe(true);
    expect(r.valid).toBe(false); // the `?? 0` regression would have made this true
  });
  it("START UNSET, END set => configured but INVALID (start=NaN) => caller fails closed", () => {
    const r = resolveSendWindow(undefined, "20", "-300");
    expect(r.configured).toBe(true);
    expect(Number.isNaN(r.startHour)).toBe(true);
    expect(r.valid).toBe(false);
  });
  it("empty-string bound is treated as unset (NaN, not 0) => invalid", () => {
    const r = resolveSendWindow("", "20", undefined);
    expect(r.configured).toBe(true); // END non-empty
    expect(Number.isNaN(r.startHour)).toBe(true);
    expect(r.valid).toBe(false);
  });
  it("honors an explicit tz offset", () => {
    expect(resolveSendWindow("9", "21", "0").tzOffsetMin).toBe(0);
  });
});

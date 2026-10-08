import { describe, expect, it } from "vitest";
import { resolveAutosendQuality } from "./autosend-quality.js";

// Pure/deterministic resolver — no Date.now, no I/O. Cases lock the rule-3
// guarantee: NO behavior change until the master flag is on.
describe("resolveAutosendQuality", () => {
  it("(1) all flags off, autosend off → both off", () => {
    expect(
      resolveAutosendQuality({
        varietyFlag: false,
        diversityGateFlag: false,
        autoEnable: false,
        autoSendEnabled: false,
      }),
    ).toEqual({ variety: false, diversityGate: false });
  });

  it("(2) autoEnable OFF + autoSendEnabled true → both off (no change until master flag on)", () => {
    expect(
      resolveAutosendQuality({
        varietyFlag: false,
        diversityGateFlag: false,
        autoEnable: false,
        autoSendEnabled: true,
      }),
    ).toEqual({ variety: false, diversityGate: false });
  });

  it("(3) autoEnable ON + autoSendEnabled false → both off (not an autosend instance)", () => {
    expect(
      resolveAutosendQuality({
        varietyFlag: false,
        diversityGateFlag: false,
        autoEnable: true,
        autoSendEnabled: false,
      }),
    ).toEqual({ variety: false, diversityGate: false });
  });

  it("(4) autoEnable ON + autoSendEnabled true → both auto-engaged", () => {
    expect(
      resolveAutosendQuality({
        varietyFlag: false,
        diversityGateFlag: false,
        autoEnable: true,
        autoSendEnabled: true,
      }),
    ).toEqual({ variety: true, diversityGate: true });
  });

  it("(5) varietyFlag true, everything else off → only variety", () => {
    expect(
      resolveAutosendQuality({
        varietyFlag: true,
        diversityGateFlag: false,
        autoEnable: false,
        autoSendEnabled: false,
      }),
    ).toEqual({ variety: true, diversityGate: false });
  });

  it("(6) diversityGateFlag true only → only the gate", () => {
    expect(
      resolveAutosendQuality({
        varietyFlag: false,
        diversityGateFlag: true,
        autoEnable: false,
        autoSendEnabled: false,
      }),
    ).toEqual({ variety: false, diversityGate: true });
  });

  it("(7) autoSendEnabled undefined + autoEnable ON → both off (undefined never counts as autosend)", () => {
    expect(
      resolveAutosendQuality({
        varietyFlag: false,
        diversityGateFlag: false,
        autoEnable: true,
        autoSendEnabled: undefined,
      }),
    ).toEqual({ variety: false, diversityGate: false });
  });
});

import { describe, expect, it } from "vitest";
import { createRepollGate } from "./repollCooldown.js";

// Union of the three per-app suites this replaces (they were the same 5 cases
// with different nouns and window constants):
//   apps/linkedin-intern/src/lib/repoll-cooldown.test.ts  (4h window, person keys)
//   apps/x-intern/src/lib/repoll-cooldown.test.ts         (4h window, person keys — byte-identical to Lyra's)
//   apps/reddit-intern/src/lib/repoll-cooldown.test.ts     (2h window, subreddit keys)
// Both real windows are exercised below so neither app's concrete constant is
// dropped, and keys from all three platforms appear so the gate stays id-agnostic.
describe("createRepollGate", () => {
  it("a never-polled key is due", () => {
    const gate = createRepollGate(4 * 3600_000, () => 1000);
    expect(gate.due("jane")).toBe(true);
  });

  it("a never-polled subreddit key is due", () => {
    const gate = createRepollGate(2 * 3600_000, () => 1000);
    expect(gate.due("saas")).toBe(true);
  });

  it("a key stamped within a 4h window is NOT due; it becomes due once the window elapses", () => {
    let now = 0;
    const gate = createRepollGate(4 * 3600_000, () => now);
    gate.stamp("jane");
    now = 3 * 3600_000;
    expect(gate.due("jane")).toBe(false);
    now = 4 * 3600_000;
    expect(gate.due("jane")).toBe(true);
  });

  it("a key stamped within a 2h window is NOT due; it becomes due once the window elapses", () => {
    let now = 0;
    const gate = createRepollGate(2 * 3600_000, () => now);
    gate.stamp("saas");
    now = 1 * 3600_000;
    expect(gate.due("saas")).toBe(false);
    now = 2 * 3600_000;
    expect(gate.due("saas")).toBe(true);
  });

  it("stamping one key leaves the others due", () => {
    const gate = createRepollGate(4 * 3600_000, () => 0);
    gate.stamp("jane");
    expect(gate.due("bob")).toBe(true);
  });

  it("stamping one subreddit key leaves the others due", () => {
    const gate = createRepollGate(2 * 3600_000, () => 0);
    gate.stamp("saas");
    expect(gate.due("experienceddevs")).toBe(true);
  });

  it("cooldown 0 disables the gate (everything always due, stamps ignored)", () => {
    const gate = createRepollGate(0, () => 0);
    gate.stamp("jane");
    expect(gate.due("jane")).toBe(true);
    gate.stamp("saas");
    expect(gate.due("saas")).toBe(true);
  });

  it("re-stamping restarts the window", () => {
    let now = 0;
    const gate = createRepollGate(1000, () => now);
    gate.stamp("jane");
    now = 1000;
    expect(gate.due("jane")).toBe(true);
    gate.stamp("jane");
    now = 1500;
    expect(gate.due("jane")).toBe(false);
  });
});

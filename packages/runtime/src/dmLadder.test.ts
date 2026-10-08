import { describe, expect, it } from "vitest";
import { DM_RUNGS, pickRung } from "./dmLadder.js";

describe("DM ladder", () => {
  it("has exactly four rungs, only the last of which proposes a call", () => {
    expect(DM_RUNGS.map((r) => r.id)).toEqual(["open", "deepen", "bridge", "invite"]);
    expect(DM_RUNGS.map((r) => r.index)).toEqual([1, 2, 3, 4]);
    expect(DM_RUNGS.filter((r) => r.proposesCall).map((r) => r.id)).toEqual(["invite"]);
  });

  it("maps sent-count → rung: 0→Open, 1→Deepen, 2→Bridge, 3+→Invite", () => {
    expect(pickRung(0).id).toBe("open");
    expect(pickRung(1).id).toBe("deepen");
    expect(pickRung(2).id).toBe("bridge");
    expect(pickRung(3).id).toBe("invite");
    expect(pickRung(9).id).toBe("invite"); // clamps at the top rung
  });

  it("never proposes a call before the top rung", () => {
    expect(pickRung(0).proposesCall).toBe(false);
    expect(pickRung(1).proposesCall).toBe(false);
    expect(pickRung(2).proposesCall).toBe(false);
    expect(pickRung(3).proposesCall).toBe(true);
  });

  it("guards NaN / negative / fractional sent-counts (falls back to rung 1)", () => {
    expect(pickRung(NaN).id).toBe("open");
    expect(pickRung(-4).id).toBe("open");
    expect(pickRung(1.9).id).toBe("deepen"); // truncates to 1
  });

  it("the Invite directive proposes a call; earlier directives negate the call ask", () => {
    const invite = DM_RUNGS.find((r) => r.id === "invite")!;
    expect(invite.directive.toLowerCase()).toContain("call");
    for (const r of DM_RUNGS.filter((r) => !r.proposesCall)) {
      // earlier rungs mention a call only to forbid it (has "call" + a negation)
      const d = r.directive.toLowerCase();
      expect(d).toContain("call");
      expect(d).toMatch(/\bnot\b|\bno\b/);
    }
  });
});

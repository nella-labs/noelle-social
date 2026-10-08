import { describe, expect, it } from "vitest";
import {
  REGISTERS,
  pickRegister,
  renderRegisterBlock,
  detectPostRegister,
  pickRegisterForPost,
  registersForPost,
} from "./register.js";

describe("REGISTERS", () => {
  it("has the five curated registers", () => {
    expect(REGISTERS.map((r) => r.id)).toEqual([
      "ULTRA_SHORT",
      "HYPE",
      "SLANG",
      "PUNCHY",
      "NORMAL",
    ]);
  });

  it("weights sum to 1 (so the [0,1) range is fully covered)", () => {
    const sum = REGISTERS.reduce((acc, r) => acc + r.weight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("NORMAL does not dominate — non-normal registers carry the majority of the weight", () => {
    const normal = REGISTERS.find((r) => r.id === "NORMAL")!.weight;
    const nonNormal = REGISTERS.filter((r) => r.id !== "NORMAL").reduce((a, r) => a + r.weight, 0);
    expect(normal).toBeLessThan(0.5);
    expect(nonNormal).toBeGreaterThan(0.5);
  });
});

describe("pickRegister (boundary values for the documented weights)", () => {
  // Cumulative boundaries: ULTRA_SHORT [0,.24) HYPE [.24,.36) SLANG [.36,.60)
  // PUNCHY [.60,.80) NORMAL [.80,1.0)
  it.each([
    [0, "ULTRA_SHORT"],
    [0.23, "ULTRA_SHORT"],
    [0.24, "HYPE"],
    [0.35, "HYPE"],
    [0.36, "SLANG"],
    [0.59, "SLANG"],
    [0.6, "PUNCHY"],
    [0.79, "PUNCHY"],
    [0.8, "NORMAL"],
    [0.99, "NORMAL"],
  ])("r=%s → %s", (r, id) => {
    expect(pickRegister(() => r).id).toBe(id);
  });

  it("a pathological r >= 1 falls back to the last register (NORMAL)", () => {
    expect(pickRegister(() => 1).id).toBe("NORMAL");
    expect(pickRegister(() => 1.5).id).toBe("NORMAL");
  });

  it("defaults to Math.random and always returns a valid register", () => {
    for (let i = 0; i < 200; i++) {
      const reg = pickRegister();
      expect(REGISTERS.map((r) => r.id)).toContain(reg.id);
    }
  });

  it("covers EVERY register across the [0,1) range at the documented weights", () => {
    const seen = new Set<string>();
    for (let r = 0; r < 1; r += 0.001) seen.add(pickRegister(() => r).id);
    expect([...seen].sort()).toEqual(["HYPE", "NORMAL", "PUNCHY", "SLANG", "ULTRA_SHORT"]);
  });
});

describe("renderRegisterBlock", () => {
  it("labels the block and carries the register's directive + the keep-rules-intact note", () => {
    const block = renderRegisterBlock(pickRegister(() => 0)); // ULTRA_SHORT
    expect(block).toContain("ASSIGNED REGISTER FOR THIS REPLY");
    expect(block).toContain("3-7 words");
    expect(block).toContain("never applies to the DM");
    // The NEVER-DO core is reaffirmed inside the block (LinkedIn keeps the
    // reframe/negative-parallelism ban too).
    expect(block).toContain("no em dashes");
    expect(block).toContain("no corporate verbs");
    expect(block).toContain("no reframe/negative-parallelism");
  });

  it("HYPE block allows caps/exclamations but only on a genuine win", () => {
    const block = renderRegisterBlock(pickRegister(() => 0.3)); // HYPE
    expect(block).toContain("LETS GOOO");
    expect(block).toContain("NOT actually a win");
  });
});

describe("detectPostRegister", () => {
  it("classifier 'light' label → celebration (authoritative)", () => {
    expect(detectPostRegister("anything at all", "light")).toBe("celebration");
  });

  it("a non-light classifier label → neutral even if the text looks celebratory", () => {
    // We do NOT override the classifier's judgement with a keyword guess.
    expect(detectPostRegister("congrats to the team, we just launched!", "substantial")).toBe("neutral");
  });

  it("no label + clearly celebratory text → celebration (heuristic fallback)", () => {
    expect(detectPostRegister("thrilled to announce we just raised our seed round")).toBe("celebration");
    expect(detectPostRegister("huge milestone today 🎉🥳 so proud of everyone!")).toBe("celebration");
  });

  it("no label + analytical text → neutral", () => {
    expect(
      detectPostRegister("the retainer-first move is the tell every time with bad sales hires"),
    ).toBe("neutral");
    expect(detectPostRegister("here's why most RAG pipelines silently degrade over time")).toBe("neutral");
  });

  it("empty / unknown → neutral", () => {
    expect(detectPostRegister("", null)).toBe("neutral");
    expect(detectPostRegister("")).toBe("neutral");
  });
});

describe("pickRegisterForPost", () => {
  it("celebration can pick HYPE (it leads the celebration subset)", () => {
    expect(pickRegisterForPost("celebration", () => 0).id).toBe("HYPE");
  });

  it("neutral NEVER picks HYPE across the whole [0,1) range, but still varies", () => {
    const seen = new Set<string>();
    for (let r = 0; r < 1; r += 0.001) seen.add(pickRegisterForPost("neutral", () => r).id);
    expect(seen.has("HYPE")).toBe(false);
    expect(seen.size).toBeGreaterThan(1);
  });

  it("celebration is dominated by HYPE (the plurality register)", () => {
    const counts: Record<string, number> = {};
    for (let r = 0; r < 1; r += 0.001) {
      const id = pickRegisterForPost("celebration", () => r).id;
      counts[id] = (counts[id] ?? 0) + 1;
    }
    expect(counts["HYPE"]).toBeGreaterThan(0);
    const max = Math.max(...Object.values(counts));
    expect(counts["HYPE"]).toBe(max);
  });

  it("defaults to Math.random and always returns a valid register", () => {
    for (let i = 0; i < 100; i++) {
      expect(REGISTERS.map((r) => r.id)).toContain(pickRegisterForPost("celebration").id);
      expect(REGISTERS.map((r) => r.id)).toContain(pickRegisterForPost("neutral").id);
    }
  });
});

describe("registersForPost", () => {
  it("celebration includes HYPE; neutral excludes it", () => {
    expect(registersForPost("celebration").map((r) => r.id)).toContain("HYPE");
    expect(registersForPost("neutral").map((r) => r.id)).not.toContain("HYPE");
  });
});

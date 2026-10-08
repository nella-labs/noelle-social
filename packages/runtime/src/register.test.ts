import { describe, expect, it } from "vitest";
import {
  REGISTERS,
  REGISTER_DIRECTIVES,
  detectPostEnergy,
  detectPostRegister,
  energyToRegister,
  isPostEnergy,
  pickRegister,
  pickRegisterForEnergy,
  pickRegisterForPost,
  registersForEnergy,
  renderEnergyHint,
  renderRegisterBlock,
  type PostEnergy,
} from "./register.js";

describe("REGISTERS", () => {
  it("weights sum to 1.00 and every register has its shared directive", () => {
    const total = REGISTERS.reduce((a, r) => a + r.weight, 0);
    expect(total).toBeCloseTo(1, 5);
    for (const r of REGISTERS) {
      expect(r.directive).toBe(REGISTER_DIRECTIVES[r.id]);
    }
  });
  it("keeps NORMAL a minority so variety stays visible across the feed", () => {
    const normal = REGISTERS.find((r) => r.id === "NORMAL")!.weight;
    const nonNormal = REGISTERS.filter((r) => r.id !== "NORMAL").reduce((a, r) => a + r.weight, 0);
    expect(normal).toBeLessThan(0.5);
    expect(nonNormal).toBeGreaterThan(0.5);
  });
  it("keeps the HYPE win-gate self-guard in its directive (blind-path safety)", () => {
    // The blind pickRegister path can assign HYPE to any post; the directive's own
    // "IF the post is NOT actually a win … react normally" is the only safety there.
    expect(REGISTER_DIRECTIVES.HYPE).toMatch(/NOT actually a win/i);
  });
});

describe("pickRegister (blind)", () => {
  // Cumulative bands: ULTRA_SHORT[0,.22) HYPE[.22,.32) SLANG[.32,.54)
  //                   PUNCHY[.54,.70) DEADPAN[.70,.80) NORMAL[.80,1)
  it("maps a stubbed rng to the expected register", () => {
    expect(pickRegister(() => 0).id).toBe("ULTRA_SHORT");
    expect(pickRegister(() => 0.25).id).toBe("HYPE");
    expect(pickRegister(() => 0.4).id).toBe("SLANG");
    expect(pickRegister(() => 0.6).id).toBe("PUNCHY");
    expect(pickRegister(() => 0.75).id).toBe("DEADPAN");
    expect(pickRegister(() => 0.9).id).toBe("NORMAL");
  });
  it("falls back to the last register on a pathological rng", () => {
    expect(pickRegister(() => 1.5).id).toBe("NORMAL");
  });
});

describe("detectPostEnergy", () => {
  it("trusts a valid persisted energy label first", () => {
    expect(
      detectPostEnergy("anything at all", { energyLabel: "joke", classifierLabel: "light" }),
    ).toBe("joke");
  });
  it("ignores an invalid energy label and falls through", () => {
    expect(detectPostEnergy("just shipped v2!!", { energyLabel: "nonsense", classifierLabel: "light" })).toBe(
      "celebration",
    );
  });
  it("classifier label 'light' means celebration", () => {
    expect(detectPostEnergy("we hit 1000 users", { classifierLabel: "light" })).toBe("celebration");
  });
  it("detects jokes / satire from text", () => {
    expect(detectPostEnergy("lol this is the most cursed API I've ever seen 💀")).toBe("joke");
    expect(detectPostEnergy("my code works on the first try, clearly a miracle /s")).toBe("joke");
    expect(detectPostEnergy("my standup ran 45 minutes to decide nothing, lmao")).toBe("joke");
  });
  it("prefers vent over joke for grief posts carrying a nervous lol/😭 (review #1)", () => {
    // "lol"/😭 are common in grief; a forced joke reply to real distress is the worst
    // misfire, so vent/question/hot_take are checked before joke.
    expect(detectPostEnergy("just got laid off after 5 years, idk what to do lol 😭")).toBe("vent");
    expect(detectPostEnergy("i'm so tired of recruiters ghosting lol")).toBe("vent");
    // a bare 😭 with no other signal is ambiguous → analytical, never joke.
    expect(detectPostEnergy("standup ran long again 😭")).toBe("analytical");
  });
  it("detects hot takes", () => {
    expect(detectPostEnergy("unpopular opinion: microservices are overrated for most teams")).toBe(
      "hot_take",
    );
    expect(detectPostEnergy("hot take, TypeScript is a scam, fight me")).toBe("hot_take");
  });
  it("detects vents", () => {
    expect(detectPostEnergy("i'm so tired of recruiters ghosting after 4 rounds")).toBe("vent");
    expect(detectPostEnergy("why does npm always break at the worst possible time")).toBe("vent");
  });
  it("detects questions", () => {
    expect(detectPostEnergy("how do you handle auth in a monorepo? anyone else struggle with this")).toBe(
      "question",
    );
    expect(detectPostEnergy("what's the best way to deploy a Hono app these days?")).toBe("question");
  });
  it("a non-light classifier label with plain text is analytical", () => {
    expect(detectPostEnergy("Here is how our retrieval pipeline reranks candidates.", {
      classifierLabel: "substantive",
    })).toBe("analytical");
  });
  it("no label + plain text falls open to analytical", () => {
    expect(detectPostEnergy("Our retrieval pipeline reranks candidates before drafting.")).toBe(
      "analytical",
    );
  });
  it("no label + celebratory text is celebration", () => {
    expect(detectPostEnergy("thrilled to announce we raised our seed round 🎉")).toBe("celebration");
  });
});

describe("energyToRegister", () => {
  it("only celebration collapses to celebration; everything else is neutral", () => {
    expect(energyToRegister("celebration")).toBe("celebration");
    for (const e of ["joke", "hot_take", "vent", "question", "analytical"] as PostEnergy[]) {
      expect(energyToRegister(e)).toBe("neutral");
    }
  });
});

describe("pickRegisterForEnergy", () => {
  it("celebration can draw HYPE; no other energy ever draws HYPE", () => {
    const rngs = Array.from({ length: 50 }, (_, i) => i / 50);
    const celebrationIds = new Set(rngs.map((r) => pickRegisterForEnergy("celebration", () => r).id));
    expect(celebrationIds.has("HYPE")).toBe(true);

    for (const e of ["joke", "hot_take", "vent", "question", "analytical"] as PostEnergy[]) {
      const ids = new Set(rngs.map((r) => pickRegisterForEnergy(e, () => r).id));
      expect(ids.has("HYPE")).toBe(false);
    }
  });
  it("a joke draws funny registers (DEADPAN present) and never a cold analytical-only set", () => {
    const rngs = Array.from({ length: 50 }, (_, i) => i / 50);
    const ids = new Set(rngs.map((r) => pickRegisterForEnergy("joke", () => r).id));
    expect(ids.has("DEADPAN")).toBe(true);
    expect(ids.has("NORMAL")).toBe(false); // a joke never gets the analytical default
  });
  it("a question never draws DEADPAN snark or HYPE", () => {
    const rngs = Array.from({ length: 50 }, (_, i) => i / 50);
    const ids = new Set(rngs.map((r) => pickRegisterForEnergy("question", () => r).id));
    expect(ids.has("DEADPAN")).toBe(false);
    expect(ids.has("HYPE")).toBe(false);
  });
  it("is deterministic for the joke subset bands", () => {
    // joke subset: DEADPAN[0,.4) PUNCHY[.4,.65) ULTRA_SHORT[.65,.85) SLANG[.85,1)
    expect(pickRegisterForEnergy("joke", () => 0).id).toBe("DEADPAN");
    expect(pickRegisterForEnergy("joke", () => 0.5).id).toBe("PUNCHY");
    expect(pickRegisterForEnergy("joke", () => 0.7).id).toBe("ULTRA_SHORT");
    expect(pickRegisterForEnergy("joke", () => 0.9).id).toBe("SLANG");
  });
  it("unknown energy falls back to the analytical subset", () => {
    const set = registersForEnergy("analytical");
    expect(registersForEnergy("totally-unknown" as PostEnergy)).toEqual(set);
  });
});

describe("renderRegisterBlock", () => {
  it("wraps the directive with the ASSIGNED REGISTER header and scope", () => {
    const block = renderRegisterBlock(
      { id: "DEADPAN", weight: 1, directive: REGISTER_DIRECTIVES.DEADPAN },
      "all three reply angles",
    );
    expect(block).toContain("ASSIGNED REGISTER FOR THIS REPLY");
    expect(block).toContain("all three reply angles");
    expect(block).toContain(REGISTER_DIRECTIVES.DEADPAN);
    expect(block).toContain("no em dashes");
  });
});

describe("backward-compatible celebration/neutral API", () => {
  it("detectPostRegister matches the old label semantics", () => {
    expect(detectPostRegister("we hit a milestone", "light")).toBe("celebration");
    expect(detectPostRegister("here's a teardown", "substantive")).toBe("neutral");
    expect(detectPostRegister("proud to announce we launched 🎉")).toBe("celebration");
    expect(detectPostRegister("a normal informative post")).toBe("neutral");
  });
  it("pickRegisterForPost keeps HYPE for celebration and drops it for neutral", () => {
    const rngs = Array.from({ length: 50 }, (_, i) => i / 50);
    const celebration = new Set(rngs.map((r) => pickRegisterForPost("celebration", () => r).id));
    const neutral = new Set(rngs.map((r) => pickRegisterForPost("neutral", () => r).id));
    expect(celebration.has("HYPE")).toBe(true);
    expect(neutral.has("HYPE")).toBe(false);
  });
});

describe("renderEnergyHint", () => {
  it("gives a mirroring hint for each non-analytical energy and '' for analytical", () => {
    expect(renderEnergyHint("joke")).toContain("answer in kind");
    expect(renderEnergyHint("joke")).toContain("do NOT explain the joke");
    expect(renderEnergyHint("vent")).toContain("Commiserate");
    expect(renderEnergyHint("vent")).toContain("chirpy");
    expect(renderEnergyHint("hot_take")).toContain("sharp take");
    expect(renderEnergyHint("celebration")).toContain("warm");
    expect(renderEnergyHint("question")).toContain("answer it");
    expect(renderEnergyHint("analytical")).toBe("");
    // Every non-analytical energy opens with the "POST ENERGY:" marker the prompt looks for.
    for (const e of ["joke", "hot_take", "vent", "celebration", "question"] as PostEnergy[]) {
      expect(renderEnergyHint(e).startsWith("POST ENERGY:")).toBe(true);
    }

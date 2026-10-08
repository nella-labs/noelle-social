import { describe, expect, it } from "vitest";
import {
  buildLanePlannerMessages,
  normalizeLaneQuery,
  parsePlannedLanes,
  planNicheLanes,
  MAX_PLANNED_LANES,
} from "./plan-lanes";

describe("normalizeLaneQuery", () => {
  it("strips #, lowercases, collapses whitespace", () => {
    expect(normalizeLaneQuery("#AI Founder")).toBe("ai founder");
    expect(normalizeLaneQuery("  Build   In Public ")).toBe("build in public");
  });
});

describe("buildLanePlannerMessages", () => {
  it("names the platform and forbids repeating existing lanes", () => {
    const { system, prompt } = buildLanePlannerMessages("grow my AI dev tool", "instagram", ["ai", "yc"]);
    expect(system).toContain("Instagram");
    expect(system).toContain("JSON");
    expect(prompt).toContain("grow my AI dev tool");
    expect(prompt).toContain("- ai");
    expect(prompt).toContain("- yc");
  });

  it("omits the 'already has' block when there are no existing lanes", () => {
    const { prompt } = buildLanePlannerMessages("x", "tiktok", []);
    expect(prompt).not.toContain("already have");
  });
});

describe("parsePlannedLanes", () => {
  it("parses, normalises, dedupes vs existing + within batch, caps", () => {
    const text = '{"queries":["#AI","ai founder","AI Founder","yc","",""]}';
    expect(parsePlannedLanes(text, ["YC"])).toEqual(["ai", "ai founder"]);
  });

  it("tolerates fenced JSON + surrounding prose", () => {
    const text = "Here you go:\n```json\n{\"queries\":[\"build in public\"]}\n```";
    expect(parsePlannedLanes(text, [])).toEqual(["build in public"]);
  });

  it("caps at MAX_PLANNED_LANES", () => {
    const many = Array.from({ length: 20 }, (_, i) => `lane${i}`);
    const text = JSON.stringify({ queries: many });
    expect(parsePlannedLanes(text, [])).toHaveLength(MAX_PLANNED_LANES);
  });

  it("returns [] for unparseable output", () => {
    expect(parsePlannedLanes("not json at all", [])).toEqual([]);
    expect(parsePlannedLanes('{"nope":1}', [])).toEqual([]);
  });

  it("drops absurdly long queries", () => {
    const text = JSON.stringify({ queries: ["ok", "x".repeat(80)] });
    expect(parsePlannedLanes(text, [])).toEqual(["ok"]);
  });
});

describe("planNicheLanes", () => {
  it("returns [] without calling the model when the objective is blank", async () => {
    let called = false;
    const out = await planNicheLanes("   ", "instagram", [], {
      call: async () => {
        called = true;
        return { text: "{}" };
      },
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("calls the model and returns parsed lanes", async () => {
    const out = await planNicheLanes("grow my startup", "instagram", ["ai"], {
      call: async ({ model }) => {
        expect(model).toBe("claude-haiku-4-5");
        return { text: '{"queries":["founder story","ai","build in public"]}' };
      },
    });
    expect(out).toEqual(["founder story", "build in public"]);
  });

  it("fails open to [] when the model call throws", async () => {
    const out = await planNicheLanes("x", "instagram", [], {
      call: async () => {
        throw new Error("bedrock down");
      },
    });
    expect(out).toEqual([]);
  });
});

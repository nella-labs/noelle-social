import { describe, expect, it } from "vitest";
import { BudgetExceededError } from "@noelle/runtime";
import { PgOperationError } from "@noelle/runtime/bounded-pg-session";
import {
  buildObjectiveGradeMessages,
  parseObjectiveGrade,
  gradeClipsForObjective,
  type GradeClip,
} from "./objective-grade.js";

const CLIPS: GradeClip[] = [
  { id: "a", caption: "how I got my first 100 AI SaaS users", authorHandle: "founderx" },
  { id: "b", caption: "cute puppy compilation", authorHandle: "dogs" },
  { id: "c", caption: "build in public day 12", authorHandle: "maker" },
];

describe("buildObjectiveGradeMessages", () => {
  it("includes the objective + every clip id and caption", () => {
    const { system, user } = buildObjectiveGradeMessages("grow my AI SaaS", CLIPS);
    expect(system).toContain("JSON");
    expect(user).toContain("grow my AI SaaS");
    expect(user).toContain("id=a");
    expect(user).toContain("cute puppy");
  });
});

describe("parseObjectiveGrade", () => {
  it("keeps only ids that exist in the batch", () => {
    expect(parseObjectiveGrade({ keep: ["a", "c", "zzz"] }, CLIPS)).toEqual(["a", "c"]);
  });
  it("returns [] for a valid empty verdict", () => {
    expect(parseObjectiveGrade({ keep: [] }, CLIPS)).toEqual([]);
  });
  it("returns null for an unparseable reply", () => {
    expect(parseObjectiveGrade({ nope: 1 }, CLIPS)).toBeNull();
    expect(parseObjectiveGrade(null, CLIPS)).toBeNull();
  });
});

describe("gradeClipsForObjective", () => {
  it("uses confident Jev verdicts without calling the legacy grader", async () => {
    const legacy = async () => { throw new Error("legacy grader must not run"); };
    const decisions = [
      { kind: "confident" as const, pass: true, probability: 0.94, provider: "jev" as const },
      { kind: "confident" as const, pass: false, probability: 0.08, provider: "jev" as const },
      { kind: "confident" as const, pass: true, probability: 0.91, provider: "jev" as const },
    ];
    const evaluate = async () => decisions.shift()!;
    const out = await gradeClipsForObjective("grow my AI SaaS", CLIPS, legacy, evaluate);
    expect(out.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("uses the current grader for uncertain Jev clips", async () => {
    const decisions = [
      { kind: "confident" as const, pass: true, probability: 0.95, provider: "jev" as const },
      { kind: "uncertain" as const, probability: 0.6, provider: "jev" as const },
      { kind: "confident" as const, pass: false, probability: 0.95, provider: "jev" as const },
    ];
    const evaluate = async () => decisions.shift()!;
    const out = await gradeClipsForObjective("grow my AI SaaS", CLIPS, async () => ({ keep: ["b"] }), evaluate);
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
  });
  it("filters to the kept subset, preserving order", async () => {
    const out = await gradeClipsForObjective("grow my AI SaaS", CLIPS, async () => ({ keep: ["c", "a"] }));
    expect(out.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("honours an explicit empty verdict (drops all)", async () => {
    const out = await gradeClipsForObjective("x", CLIPS, async () => ({ keep: [] }));
    expect(out).toEqual([]);
  });

  it("fails open (keeps all) when the call returns null", async () => {
    const out = await gradeClipsForObjective("x", CLIPS, async () => null);
    expect(out).toEqual(CLIPS);
  });

  it("fails open when the call throws", async () => {
    const out = await gradeClipsForObjective("x", CLIPS, async () => {
      throw new Error("gemini down");
    });
    expect(out).toEqual(CLIPS);
  });

  it.each([
    new BudgetExceededError({ layer: "instance", spent_cents: 1, cap_cents: 1, estimated_cents: 1 }),
    new PgOperationError("database"),
  ])("propagates rejected fallback admission %s instead of keeping the batch", async error => {
    const unavailable = async () => ({ kind: "unavailable" as const, provider: "jev" as const });
    await expect(gradeClipsForObjective("saved objective", CLIPS, async () => { throw error; }, unavailable)).rejects.toBe(error);
  });

  it("skips the call entirely for a blank objective or empty batch", async () => {
    let called = false;
    const mark: () => Promise<unknown> = async () => {
      called = true;
      return { keep: [] };
    };
    expect(await gradeClipsForObjective("   ", CLIPS, mark)).toEqual(CLIPS);
    expect(await gradeClipsForObjective("x", [], mark)).toEqual([]);
    expect(called).toBe(false);
  });
});

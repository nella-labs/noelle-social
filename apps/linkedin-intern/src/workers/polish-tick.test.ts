import { describe, it, expect, vi } from "vitest";
import { runPolishTick } from "./polish-tick.js";
import type { RunPolishTickArgs } from "./polish-tick.js";

const clean = { hook: "Remote interviews eat a candidate's evening", thesis: "Share the salary before asking for another call" };
const original = { hook: "Interview schedules waste evenings", thesis: null, angle: "observation", pillar: "hiring" };
const reply = (idea: typeof clean & { repair_id?: number }) => ({ text: JSON.stringify(idea), engine: "test", model: "test" });
const setup = (runner: RunPolishTickArgs["runner"]) => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  instance: { id: "i1", org_id: "o1", model_overrides: null, objective: null } as RunPolishTickArgs["instance"],
  request: { ideaId: "idea1" } as RunPolishTickArgs["request"],
  loadIdea: vi.fn().mockResolvedValue({ ...original }),
  voiceAnchors: vi.fn().mockResolvedValue(["plain opinions about hiring"]),
  runner,
  apply: vi.fn(),
});

describe("runPolishTick", () => {
  it.each(["hook", "thesis"] as const)("rewrites a banned %s once before updating the idea", async (field) => {
    const runner = { draft: vi.fn()
      .mockResolvedValueOnce(reply({ ...clean, [field]: "Let that sink in." }))
      .mockResolvedValueOnce(reply({ ...clean, repair_id: 0 })) };
    const args = setup(runner);
    expect(await runPolishTick(args)).toBe(1);
    expect(runner.draft).toHaveBeenCalledTimes(2);
    const repair = runner.draft.mock.calls[1]![0].prompt as string;
    expect(repair).toContain("Let that sink in.");
    expect(repair).toContain(field);
    expect(args.apply).toHaveBeenCalledExactlyOnceWith("idea1", clean);
  });

  it.each(["bad", "invalid"])("leaves the stored idea untouched after a %s rewrite", async (retry) => {
    const bad = reply({ ...clean, thesis: "Let that sink in." });
    const badRepair = reply({ ...clean, thesis: "Let that sink in.", repair_id: 0 });
    const runner = { draft: vi.fn()
      .mockResolvedValueOnce(bad)
      .mockResolvedValueOnce(retry === "bad" ? badRepair : { ...bad, text: "not json" }) };
    const args = setup(runner);
    await expect(runPolishTick(args)).rejects.toThrow();
    expect(runner.draft).toHaveBeenCalledTimes(2);
    expect(args.apply).not.toHaveBeenCalled();
    expect(await args.loadIdea("idea1")).toEqual(original);
  });

  it("saves a clean idea without a rewrite", async () => {
    const runner = { draft: vi.fn().mockResolvedValue(reply(clean)) };
    const args = setup(runner);
    expect(await runPolishTick(args)).toBe(1);
    expect(runner.draft).toHaveBeenCalledOnce();
    expect(args.apply).toHaveBeenCalledExactlyOnceWith("idea1", clean);
  });

  it("keeps the existing parse-failure behavior and does not write", async () => {
    const runner = { draft: vi.fn().mockResolvedValue({ text: "not json" }) };
    const args = setup(runner);
    expect(await runPolishTick(args)).toBe(0);
    expect(runner.draft).toHaveBeenCalledOnce();
    expect(args.apply).not.toHaveBeenCalled();
  });
});

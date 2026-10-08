import { beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetExceededError, PgOperationError } from "@noelle/runtime";
const { readRules } = vi.hoisted(() => ({ readRules: vi.fn() }));
const batch = vi.hoisted(() => ({ active: false, claim: vi.fn(), revert: vi.fn(), stamp: vi.fn(), draft: vi.fn() }));
vi.mock("../lib/pattern-breaker-db.js", () => ({ loadActivePatternRules: readRules }));
vi.mock("@noelle/runtime", async original => ({ ...await original<Record<string, unknown>>(),
  evaluateJevBoolean: async () => ({ kind: "unavailable", provider: "jev" }) }));
vi.mock("../lib/video-ideas-db.js", async original => {
  const actual = await original<typeof import("../lib/video-ideas-db.js")>();
  return { ...actual, claimApprovedIdeas: (...args: Parameters<typeof actual.claimApprovedIdeas>) =>
    batch.active ? batch.claim(...args) : actual.claimApprovedIdeas(...args),
  revertIdeaToApproved: (...args: Parameters<typeof actual.revertIdeaToApproved>) =>
    batch.active ? batch.revert(...args) : actual.revertIdeaToApproved(...args),
  markIdeaDrafted: (...args: Parameters<typeof actual.markIdeaDrafted>) => batch.active ? batch.stamp(...args) : actual.markIdeaDrafted(...args) };
});
vi.mock("../lib/video-drafts-db.js", () => ({ insertVideoDraft: batch.draft }));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const instance = {
  id: "22222222-2222-4222-8222-222222222222",
  org_id: "11111111-1111-4111-8111-111111111111",
  objective: "Share concrete lessons from building products",
  dm_autodraft_enabled: false,
};
beforeEach(() => {
  batch.active = false;
  readRules.mockReset();
  vi.clearAllMocks();
  batch.revert.mockReset().mockResolvedValue(undefined); batch.stamp.mockReset().mockResolvedValue(undefined); batch.draft.mockReset().mockResolvedValue("draft");
});
async function videoTick() {
  const { runScripterTick } = await import("./scripter-tick.js");
  const claimWrites: string[] = [];
  const requests: unknown[] = [];
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("update noelle.video_ideas set status = 'drafting'")) {
        claimWrites.push(text);
        return [
          {
            id: "33333333-3333-4333-8333-333333333333",
            org_id: instance.org_id,
            platform: "tiktok",
            hook: "A concrete migration lesson",
            concept: null,
            inspiration_clip_ids: [],
          },
        ];
      }
      return [];
    }),
    { json: (value: unknown) => value },
  );
  await runScripterTick({
    sql,
    instance,
    log,
    batchLimit: 1,
    model: "fixture",
    scripter: {
      script: async (request: unknown) => {
        requests.push(request);
        return null;
      },
    },
  } as unknown as Parameters<typeof runScripterTick>[0]).catch(() => undefined);
  return { requests, claimWrites };
}

describe("standing-rule admission at the actual Video tick", () => {
  it.each(["unavailable", "malformed", "incomplete"])(
    "claims and dispatches no work after %s rules",
    async (failure) => {
      readRules.mockRejectedValue(new Error(`Standing rules ${failure}`));
      const effects = await videoTick();
      expect(readRules).toHaveBeenCalledOnce();
      expect({
        claims: effects.claimWrites.length,
        scriptRequests: effects.requests.length,
      }).toEqual({ claims: 0, scriptRequests: 0 });
    },
  );

  it("still claims and attempts a script when the complete standing-rule set is measured empty", async () => {
    readRules.mockResolvedValue([]);
    const effects = await videoTick();
    expect(readRules).toHaveBeenCalledOnce();
    expect(effects.claimWrites).toHaveLength(1);
    expect(effects.requests).toHaveLength(1);
  });
});

const denied = () => new BudgetExceededError({ layer: "instance", spent_cents: 0, cap_cents: 0, estimated_cents: 1 });
const output = { hook: "A concrete lesson", script: "A useful lesson from building.", structure: [], transitions: [], sounds: [], graphSpecs: [] };
async function batchTick(script: ReturnType<typeof vi.fn>, verifyJson?: ReturnType<typeof vi.fn>) {
  batch.active = true; readRules.mockResolvedValue([]);
  batch.claim.mockResolvedValue(["first", "second", "third"].map(id => ({ id, org_id: instance.org_id,
    platform: "instagram", hook: "A concrete lesson", concept: null, inspiration_clip_ids: [] })));
  const { runScripterTick } = await import("./scripter-tick.js");
  const deps = { sql: Object.assign(vi.fn(async () => []), { json: (value: unknown) => value }), instance, log,
    scripter: { script }, batchLimit: 3, model: "fixture",
    ...(verifyJson ? { verifyJson, verify: { enabled: true, retries: 1, voiceFloor: 0.65 } } : {}) };
  return { deps, result: runScripterTick(deps as unknown as Parameters<typeof runScripterTick>[0]) };
}
describe("scripter paid batch admission", () => {
  it.each([denied, () => new PgOperationError("deadline")])("stops and releases unstarted ideas after canonical refusal %#", async refusal => {
    const error = refusal(); const script = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(null);
    const run = await batchTick(script);
    await expect(run.result).rejects.toMatchObject({ cause: error, rowsProcessed: 0 });
    expect(script).toHaveBeenCalledOnce();
    expect(batch.revert.mock.calls.map(args => args[1])).toEqual(["first", "second", "third"]);
    expect(batch.draft).not.toHaveBeenCalled();
  });
  it("continues ordinary per-idea failures", async () => {
    const script = vi.fn().mockRejectedValueOnce(new Error("ordinary failure")).mockResolvedValue(null);
    expect(await (await batchTick(script)).result).toBe(0); expect(script).toHaveBeenCalledTimes(3);
  });
  it("keeps earlier output and awaits all cleanup even after a cleanup rejection", async () => {
    const error = denied(); let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    batch.revert.mockRejectedValueOnce(new Error("cleanup unavailable")).mockImplementationOnce(() => cleanup);
    const script = vi.fn().mockResolvedValueOnce(output).mockRejectedValueOnce(error).mockResolvedValue(null);
    const run = await batchTick(script); let settled = false;
    const finished = run.result.then(() => { settled = true; }, err => { settled = true; return err; });
    await vi.waitFor(() => expect(batch.revert).toHaveBeenCalledTimes(2)); expect(settled).toBe(false);
    release(); expect(await finished).toMatchObject({ cause: error, rowsProcessed: 1 });
    expect(script).toHaveBeenCalledTimes(2); expect(batch.draft).toHaveBeenCalledOnce();
    expect(batch.revert.mock.calls.map(args => args[1])).toEqual(["second", "third"]); expect(log.warn).toHaveBeenCalled();
  });
  it("stops after verifier admission rather than regenerating or writing the candidate", async () => {
    const error = denied(); const judge = vi.fn().mockRejectedValue(error); const script = vi.fn().mockResolvedValue(output);
    await expect((await batchTick(script, judge)).result).rejects.toMatchObject({ cause: error, rowsProcessed: 0 });
    expect(script).toHaveBeenCalledOnce(); expect(judge).toHaveBeenCalledOnce(); expect(batch.draft).not.toHaveBeenCalled();
  });
  it("stops a denied regeneration and releases later ideas", async () => {
    const error = denied(); const script = vi.fn().mockResolvedValueOnce(output).mockRejectedValueOnce(error);
    const judge = vi.fn().mockResolvedValue({ voice: 0.1, grounding: 0.1, relevance: 0.1, fix: "Use the supplied lesson" });
    await expect((await batchTick(script, judge)).result).rejects.toMatchObject({ cause: error, rowsProcessed: 0 });
    expect(script).toHaveBeenCalledTimes(2); expect(judge).toHaveBeenCalledOnce(); expect(batch.draft).not.toHaveBeenCalled();
  });
  it("finishes the actual worker as error with earlier acknowledged rows", async () => {
    batch.active = true; readRules.mockResolvedValue([]);
    batch.claim.mockResolvedValue(["first", "second"].map(id => ({ id, org_id: instance.org_id,
      platform: "instagram", hook: "A concrete lesson", concept: null, inspiration_clip_ids: [] })));
    const error = denied(); const script = vi.fn().mockResolvedValueOnce(output).mockRejectedValueOnce(error);
    const finish = vi.fn(async () => {}); const sql = Object.assign(vi.fn(async () => []), { json: (v: unknown) => v });
    vi.doMock("../env.js", () => ({ loadEnv: () => ({ WORKER_ID: "fixture", SCRIPTER_BATCH: 3 }) }));
    vi.doMock("../lib/logger.js", () => ({ createLogger: () => log }));
    vi.doMock("../lib/db.js", () => ({ noelleDb: () => sql }));
    vi.doMock("../lib/boot.js", () => ({ runBootChecks: async () => ({ ok: true }), EX_TEMPFAIL: 75 }));
    vi.doMock("../lib/worker-runs.js", () => ({ recordRun: async () => ({ finish }) }));
    vi.doMock("../lib/text-backend.js", () => ({ createTextJsonFn: () => ({ forInstance: () => vi.fn(), model: "fixture", engine: "bedrock" }) }));
    vi.doMock("../lib/video-generate.js", () => ({ createScripter: () => ({ script }) }));
    vi.doMock("../lib/vault-grounding.js", async original => ({ ...await original<Record<string, unknown>>(), createVaultKb: () => null }));
    vi.doMock("./_runtime.js", () => ({ installShutdown: () => () => true,
      runWorkerLoop: async (args: { onTick: (inst: typeof instance) => Promise<void> }) => args.onTick(instance) }));
    try {
      await import("./scripter.js");
      await vi.waitFor(() => expect(finish).toHaveBeenCalledWith({ status: "error", rowsProcessed: 1, errorMessage: error.message }));
      expect(finish).toHaveBeenCalledOnce(); expect(script).toHaveBeenCalledTimes(2);
    } finally {
      for (const path of ["../env.js", "../lib/logger.js", "../lib/db.js", "../lib/boot.js", "../lib/worker-runs.js",
        "../lib/text-backend.js", "../lib/video-generate.js", "../lib/vault-grounding.js", "./_runtime.js"]) vi.doUnmock(path);
    }
  });
});

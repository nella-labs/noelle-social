import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingBriefOutputSchema, VideoTeardownSchema } from "@noelle/contracts";
import { createTextJsonFn, createVideoModelMetering } from "../lib/text-backend.js";
import { createBriefer } from "../lib/brief-generate.js";
import { createVertexVideoAnalyzer } from "../lib/teardown-analyze.js";
import { createLogger } from "../lib/logger.js";
import { runBrieferTick } from "./briefer-tick.js";
import { runTeardownTick } from "./teardown-tick.js";
import type { Env } from "../env.js";
import { ModelNotDispatchedError } from "@noelle/runtime";

const raw = vi.hoisted(() => ({ text: vi.fn(), extract: vi.fn(), lostBriefAck: false, lostTeardownAck: false, changeBrief: false }));
vi.mock("@noelle/runtime", async original => ({ ...await original<Record<string, unknown>>(),
  createBedrockBackend: () => ({ call: raw.text }) }));
vi.mock("@noelle/video-extract", () => ({ extractVideo: raw.extract }));
vi.mock("../lib/recording-briefs-db.js", async original => {
  const owner = await original<typeof import("../lib/recording-briefs-db.js")>();
  return { ...owner, markBriefDispatched: async (...args: Parameters<typeof owner.markBriefDispatched>) => {
    if (raw.changeBrief) await args[0]`update noelle.video_drafts set final_script='Changed after admission' where id=${args[1].draft_id}`;
    const result = await owner.markBriefDispatched(...args);
    if (raw.lostBriefAck) throw new ModelNotDispatchedError();
    return result;
  } };
});
vi.mock("../lib/teardown-db.js", async original => {
  const owner = await original<typeof import("../lib/teardown-db.js")>();
  return { ...owner, markTeardownDispatched: async (...args: Parameters<typeof owner.markTeardownDispatched>) => {
    const result = await owner.markTeardownDispatched(...args);
    if (raw.lostTeardownAck) throw new ModelNotDispatchedError();
    return result;
  } };
});
const url = process.env.NOELLE_VIDEO_MODEL_ADMISSION_TEST_DATABASE_URL;
const brief = RecordingBriefOutputSchema.parse({ title: "Saved shoot plan", runtimeTarget: 15, hookCheck: "Clear opening",
  shotList: [], bRoll: [], camAngles: [], props: { inFrame: [], mustNotBeInFrame: [] }, onTheDayNotes: [] });
const teardown = VideoTeardownSchema.parse({ hook: { text: "Saved hook", type: "question" },
  pacing: { cutsPerSec: 0.1, avgBeatSec: 1, wordsPerSec: 1 }, cta: { present: false }, sound: {}, whyItWorked: "Observed structure" });

describe.skipIf(!url)("Video model admission before durable dispatch (native PostgreSQL)", () => {
  let sql: Sql; let org: string; let instance: string;
  const log = createLogger({ kind: "model-admission-native", workerId: "native" }); log.level = "silent";
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {}, connection: { application_name: "video-model-admission-native" } });
    if ((await sql`select current_database() as name`)[0]?.name !== "noelle_video_model_admission_test")
      throw new Error("Dedicated Video model admission database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0014_llm_calls_agent_instance_id.sql", "0033_connections_credentials.sql",
      "0065_video_intern_watchlist.sql", "0066_video_intern_corpus.sql", "0067_video_intern_studio.sql", "0073_video_self_tracking.sql",
      "0080_video_recording_briefs.sql", "0097_budget_cap_pause.sql", "0116_llm_budget_reservations.sql", "0117_llm_cost_basis.sql",
      "0120_video_metrics_nullable.sql", "0122_video_teardown_attempts.sql", "0123_video_recording_brief_attempts.sql",
      "0124_video_teardown_preparation_failed.sql"])
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    org = String((await sql`insert into noelle.organizations(slug,name) values ('dispatch_owned','Owned') returning id`)[0]!.id);
    instance = String((await sql`insert into noelle.agent_instances(org_id,role,budget_cap_cents)
      values (${org},'video_intern',10000) returning id`)[0]!.id);
    raw.text.mockReset().mockResolvedValue({ text: JSON.stringify(brief), usage: { input_tokens: 12, output_tokens: 8, cost_usd: 0.03 } });
    raw.extract.mockReset().mockResolvedValue({ transcript: "Saved transcript", keyframePaths: [], cutTimestamps: [], durationS: 1 });
    raw.lostBriefAck = false; raw.lostTeardownAck = false; raw.changeBrief = false;
    vi.stubEnv("AWS_ACCESS_KEY_ID", "inert-fixture"); vi.stubEnv("AWS_SECRET_ACCESS_KEY", "inert-fixture");
  });
  afterAll(async () => { vi.unstubAllEnvs(); await sql?.end({ timeout: 0 }); await new Promise(resolve => setTimeout(resolve, 1500)); });
  const active = () => ({ id: instance, org_id: org, status: "active" as const, objective: null, video_feeder_config: null, budget_cap_cents: null });
  async function readyDraft() {
    const idea = String((await sql`insert into noelle.video_ideas(org_id,agent_instance_id,hook)
      values (${org},${instance},'Saved hook') returning id`)[0]!.id);
    await sql`insert into noelle.video_drafts(org_id,agent_instance_id,idea_id,status,script)
      values (${org},${instance},${idea},'ready','Approved saved script')`;
  }
  const briefTick = () => {
    const text = createTextJsonFn({ NOELLE_CLAUDE_CLI: "0", NOELLE_VIDEO_TEXT_MODEL: "claude-sonnet-4-6" } as Env, { sql, worker: "briefer" });
    return runBrieferTick({ sql, log, instance: active(), briefer: createBriefer(text.forInstance(active())),
      batchLimit: 4, sourceEngine: text.engine, model: text.model });
  };
  async function clip() {
    await sql`insert into noelle.video_clips(org_id,agent_instance_id,external_id,author_handle,caption,url)
      values (${org},${instance},'saved','example','Saved caption','https://example.test/reel/saved')`;
  }
  function analyzerTick() {
    const http = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(teardown) }] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 } })));
    const analyzer = createVertexVideoAnalyzer({ project: "", apiKey: "inert-fixture", fetchImpl: http,
      metering: createVideoModelMetering(sql, "teardown")(active(), "vertex") });
    return { http, run: () => runTeardownTick({ sql, log, instance: active(), bulkAnalyzer: analyzer, deepAnalyzer: analyzer, batchLimit: 4, dailyCap: 200 }) };
  }
  const receipts = () => sql`select org_id,agent_instance_id,worker,status,cost_basis,cents,attempt_id from noelle.llm_calls order by started_at,id`;

  it("releases a brief rejected by the actual scoped factory before marking dispatch", async () => {
    await readyDraft(); await sql`update noelle.agent_instances set budget_cap_cents=0 where id=${instance}`;
    await briefTick().catch(error => expect(error).toBeInstanceOf(Error));
    expect(raw.text).not.toHaveBeenCalled();
    expect(await receipts()).toEqual([expect.objectContaining({ org_id: org, agent_instance_id: instance, worker: "briefer",
      status: "budget_exceeded", cost_basis: "not_dispatched", cents: 0, attempt_id: null })]);
    const [claim] = await sql`select status,reason,dispatched_at from noelle.video_recording_brief_attempts`;
    expect(claim?.dispatched_at).toBeNull(); expect(claim).toMatchObject({ status: "released", reason: "preparation_failed" });
    expect(await sql`select id from noelle.video_recording_briefs where status='ready'`).toHaveLength(0);
  });
  it("releases a teardown rejected by actual metered Gemini before marking dispatch", async () => {
    await clip(); await sql`update noelle.agent_instances set budget_cap_cents=0 where id=${instance}`;
    const run = analyzerTick(); await run.run().catch(error => expect(error).toBeInstanceOf(Error));
    expect(run.http).not.toHaveBeenCalled();
    expect(await receipts()).toEqual([expect.objectContaining({ org_id: org, agent_instance_id: instance, worker: "teardown",
      status: "budget_exceeded", cost_basis: "not_dispatched", cents: 0, attempt_id: null })]);
    const [claim] = await sql`select status,reason,dispatched_at from noelle.video_teardown_attempts`;
    expect(claim?.dispatched_at).toBeNull(); expect(claim).toMatchObject({ status: "released", reason: "preparation_failed" });
    expect(await sql`select id from noelle.video_teardowns`).toHaveLength(0);
  });
  it("retains healthy text completion, exact charge/provenance and no replay", async () => {
    raw.text.mockImplementationOnce(async () => {
      expect((await sql`select count(*)::int as n from pg_stat_activity where datname=current_database()
        and pid<>pg_backend_pid() and (state like 'idle in transaction%' or backend_xid is not null)`)[0]?.n).toBe(0);
      return { text: JSON.stringify(brief), usage: { input_tokens: 12, output_tokens: 8, cost_usd: 0.03 } };
    });
    await readyDraft(); expect(await briefTick()).toBe(1); expect(await briefTick()).toBe(0);
    expect(raw.text).toHaveBeenCalledOnce(); expect(await receipts()).toHaveLength(1);
    expect((await receipts())[0]).toMatchObject({ worker: "briefer", status: "ok", cost_basis: "provider_reported", cents: 3 });
    expect((await sql`select status,source_engine,model from noelle.video_recording_briefs`)[0])
      .toMatchObject({ status: "ready", source_engine: "bedrock", model: "claude-sonnet-4-6" });
  });
  it("retains healthy Gemini completion and no replay", async () => {
    await clip(); const run = analyzerTick(); expect(await run.run()).toBe(1); expect(await run.run()).toBe(0);
    expect(run.http).toHaveBeenCalledOnce(); expect(await receipts()).toHaveLength(1);
    expect((await receipts())[0]).toMatchObject({ worker: "teardown", status: "ok", cost_basis: "token_estimate" });
    expect((await sql`select status from noelle.video_teardown_attempts`)[0]).toMatchObject({ status: "complete" });
  });
  it("keeps a committed brief marker with a lost nominal acknowledgement held and never replays it", async () => {
    await readyDraft(); raw.lostBriefAck = true;
    await expect(briefTick()).rejects.toMatchObject({ reason: "dispatch_uncertain" });
    await expect(briefTick()).rejects.toMatchObject({ reason: "dispatch_uncertain" });
    expect(raw.text).not.toHaveBeenCalled(); expect(await receipts()).toHaveLength(1);
    expect((await receipts())[0]).toMatchObject({ status: "error", cost_basis: "unknown", cents: 0 });
    const [claim] = await sql`select status,reason,dispatched_at from noelle.video_recording_brief_attempts`;
    expect(claim).toMatchObject({ status: "unknown", reason: "dispatch_uncertain" }); expect(claim?.dispatched_at).not.toBeNull();
    expect(await sql`select id from noelle.llm_budget_reservations where settled_at is null`).toHaveLength(1);
    expect(await sql`select id from noelle.video_recording_briefs where status='ready'`).toHaveLength(0);
  });
  it("keeps a committed teardown marker with a lost nominal acknowledgement held and never replays it", async () => {
    await clip(); raw.lostTeardownAck = true; const run = analyzerTick();
    await expect(run.run()).rejects.toMatchObject({ reason: "dispatch_uncertain" });
    await expect(run.run()).rejects.toMatchObject({ reason: "dispatch_uncertain" });
    expect(run.http).not.toHaveBeenCalled(); expect(await receipts()).toHaveLength(1);
    const [claim] = await sql`select status,reason,dispatched_at from noelle.video_teardown_attempts`;
    expect(claim).toMatchObject({ status: "unknown", reason: "dispatch_uncertain" }); expect(claim?.dispatched_at).not.toBeNull();
    expect(await sql`select id from noelle.llm_budget_reservations where settled_at is null`).toHaveLength(1);
    expect(await sql`select id from noelle.video_teardowns`).toHaveLength(0);
  });
  it("settles measured zero while retaining successful brief provenance", async () => {
    await readyDraft(); raw.text.mockResolvedValueOnce({ text: JSON.stringify(brief), usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 } });
    expect(await briefTick()).toBe(1); expect(raw.text).toHaveBeenCalledOnce();
    expect((await receipts())[0]).toMatchObject({ status: "ok", cost_basis: "provider_reported", cents: 0 });
    expect(await sql`select id from noelle.llm_budget_reservations where settled_at is null`).toHaveLength(0);
  });
  it("retains unknown usage and malformed output without replay or a fabricated ready receipt", async () => {
    await readyDraft(); raw.text.mockResolvedValueOnce({ text: "not JSON", usage: { input_tokens: 0, output_tokens: 0, token_usage_reported: false } });
    await expect(briefTick()).rejects.toMatchObject({ reason: "generation_unknown" });
    await expect(briefTick()).rejects.toMatchObject({ reason: "generation_unknown" });
    expect(raw.text).toHaveBeenCalledOnce(); expect(await receipts()).toHaveLength(1);
    expect((await receipts())[0]).toMatchObject({ status: "ok", cost_basis: "unknown", cents: 0 });
    expect(await sql`select id from noelle.llm_budget_reservations where settled_at is null`).toHaveLength(1);
    expect(await sql`select id from noelle.video_recording_briefs where status='ready'`).toHaveLength(0);
  });
  it("preserves prior completion and releases unstarted claims after actual later admission denial", async () => {
    await readyDraft(); await readyDraft(); await readyDraft();
    raw.text.mockImplementationOnce(async () => {
      await sql`update noelle.agent_instances set budget_cap_cents=0 where id=${instance}`;
      return { text: JSON.stringify(brief), usage: { input_tokens: 12, output_tokens: 8, cost_usd: 0.03 } };
    });
    await expect(briefTick()).rejects.toMatchObject({ reason: "preparation_failed", rowsProcessed: 1 });
    expect(raw.text).toHaveBeenCalledOnce(); expect(await receipts()).toHaveLength(2);
    const claims = await sql`select status,reason,dispatched_at from noelle.video_recording_brief_attempts order by created_at,id`;
    expect(claims.filter(row => row.status === "complete")).toHaveLength(1);
    expect(claims.filter(row => row.status === "released" && row.reason === "preparation_failed" && row.dispatched_at === null)).toHaveLength(2);
    expect(await sql`select id from noelle.video_recording_briefs where status='ready'`).toHaveLength(1);
  });
  it("settles an acknowledged marker rejection without releasing a changed source claim", async () => {
    await readyDraft(); raw.changeBrief = true;
    await expect(briefTick()).rejects.toMatchObject({ reason: "source_changed" });
    expect(raw.text).not.toHaveBeenCalled(); expect(await receipts()).toHaveLength(1);
    expect((await receipts())[0]).toMatchObject({ status: "error", cost_basis: "not_dispatched", cents: 0 });
    expect(await sql`select id from noelle.llm_budget_reservations where settled_at is null`).toHaveLength(0);
    expect((await sql`select status,reason,dispatched_at from noelle.video_recording_brief_attempts`)[0])
      .toMatchObject({ status: "failed", reason: "source_changed", dispatched_at: null });
  });
  it("retains a dispatched provider failure and its estimated receipt without replay", async () => {
    await readyDraft(); raw.text.mockRejectedValueOnce(new ModelNotDispatchedError());
    await expect(briefTick()).rejects.toMatchObject({ reason: "generation_failed" });
    await expect(briefTick()).rejects.toMatchObject({ reason: "generation_failed" });
    expect(raw.text).toHaveBeenCalledOnce(); expect(await receipts()).toHaveLength(1);
    expect((await receipts())[0]).toMatchObject({ status: "error", cost_basis: "failure_estimate" });
    expect(await sql`select id from noelle.llm_budget_reservations where settled_at is null`).toHaveLength(1);
    const [claim] = await sql`select status,reason,dispatched_at from noelle.video_recording_brief_attempts`;
    expect(claim).toMatchObject({ status: "failed", reason: "generation_failed" }); expect(claim?.dispatched_at).not.toBeNull();
  });
});

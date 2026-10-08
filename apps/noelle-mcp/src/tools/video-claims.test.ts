import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { NoelleContext } from "../context.js";
import type { Env } from "../env.js";
import { videoClaimsModule } from "./video-claims.js";
import { withToolAnnotations } from "../tool-annotations.js";
import { MODULES } from "./index.js";

const owners = vi.hoisted(() => ({ listVideoGenerationHolds: vi.fn(), retryVideoTeardown: vi.fn(), retryRecordingBrief: vi.fn() }));
vi.mock("@noelle/runtime/video-generation-holds-db", () => ({ listVideoGenerationHolds: owners.listVideoGenerationHolds }));
vi.mock("@noelle/runtime/video-teardown-claims-db", () => ({ retryVideoTeardown: owners.retryVideoTeardown }));
vi.mock("@noelle/runtime/video-recording-brief-db", () => ({ retryRecordingBrief: owners.retryRecordingBrief }));
const org = "00000000-0000-4000-8000-000000000001";
const instanceId = "00000000-0000-4000-8000-000000000002";
const clipId = "00000000-0000-4000-8000-000000000003";
const expectedClaimUUID = "00000000-0000-4000-8000-000000000004";
function context() {
  return { sql: {}, resolveOrg: vi.fn(async () => ({ orgId: org })), assertWritable: vi.fn(),
    operatorId: () => "operator" } as unknown as NoelleContext;
}
beforeEach(() => {
  vi.clearAllMocks(); owners.listVideoGenerationHolds.mockResolvedValue({ holds: [], returnedCount: 0, nextCursor: null });
  owners.retryVideoTeardown.mockResolvedValue("queued-id"); owners.retryRecordingBrief.mockResolvedValue("brief-queued-id");
});
describe("Video generation operator tools", () => {
  it("returns a scoped bounded page without treating it as a whole-history count", async () => {
    const ctx = context(); const result = await videoClaimsModule.handle("noelle_list_video_generation_holds",
      { org: "owned", instanceId, kind: "recording_brief", limit: 3, cursor: "saved-cursor" }, ctx);
    expect(result?.isError).not.toBe(true); expect(ctx.resolveOrg).toHaveBeenCalledWith("owned");
    expect(owners.listVideoGenerationHolds).toHaveBeenCalledWith(ctx.sql,
      { orgId: org, instanceId, kind: "recording_brief", limit: 3, cursor: "saved-cursor" });
    expect(JSON.parse(result!.content[0]!.text)).toEqual({ holds: [], returnedCount: 0, nextCursor: null });
    expect(ctx.assertWritable).not.toHaveBeenCalled();
    const tool = videoClaimsModule.tools.find(t => t.name === "noelle_list_video_generation_holds")!;
    expect(withToolAnnotations(tool).annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });
  it.each([undefined, false, "true"])("requires literal true acknowledgement: %s", async acknowledgeUnresolvedOperation => {
    const result = await videoClaimsModule.handle("noelle_retry_video_teardown",
      { instanceId, clipId, expectedClaimUUID, acknowledgeUnresolvedOperation }, context());
    expect(result?.isError).toBe(true); expect(owners.retryVideoTeardown).not.toHaveBeenCalled();
  });
  it("queues an exact expected attempt with operator attribution and dispatches no network request", async () => {
    const ctx = context(); const network = vi.spyOn(globalThis, "fetch");
    try {
      const result = await videoClaimsModule.handle("noelle_retry_video_teardown",
        { instanceId, clipId, expectedClaimUUID, acknowledgeUnresolvedOperation: true }, ctx);
      expect(ctx.assertWritable).toHaveBeenCalledOnce();
      expect(owners.retryVideoTeardown).toHaveBeenCalledWith(ctx.sql, { orgId: org, instanceId, clipId, expectedClaimUUID, operatorId: "operator" });
      expect(JSON.parse(result!.content[0]!.text)).toEqual({ status: "queued", claimId: "queued-id", providerExecutionMayBeUnresolved: true });
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it("refuses read-only and stale expected identities without false acknowledgement", async () => {
    const ctx = context(); vi.mocked(ctx.assertWritable).mockImplementation(() => { throw new Error("Read-only mode"); });
    const args = { instanceId, clipId, expectedClaimUUID, acknowledgeUnresolvedOperation: true };
    expect((await videoClaimsModule.handle("noelle_retry_video_teardown", args, ctx))?.isError).toBe(true);
    expect(owners.retryVideoTeardown).not.toHaveBeenCalled(); owners.retryVideoTeardown.mockResolvedValue(null);
    expect((await videoClaimsModule.handle("noelle_retry_video_teardown", args, context()))?.isError).toBe(true);
  });
  it.each([{ instanceId: "bad" }, { instanceId, limit: 0 }, { instanceId, limit: 51 }, { instanceId, limit: 1.5 }])(
    "rejects invalid identity or page inputs before database work", async args => {
      expect((await videoClaimsModule.handle("noelle_list_video_generation_holds", args, context()))?.isError).toBe(true);
      expect(owners.listVideoGenerationHolds).not.toHaveBeenCalled();
    });
  it("queues a recording brief through the same scoped operator contract with no network dispatch", async () => {
    const ctx = context(); const network = vi.spyOn(globalThis, "fetch");
    try {
      const result = await videoClaimsModule.handle("noelle_retry_recording_brief",
        { org: "owned", instanceId, draftId: clipId, expectedClaimUUID, acknowledgeUnresolvedOperation: true }, ctx);
      expect(ctx.resolveOrg).toHaveBeenCalledWith("owned"); expect(ctx.assertWritable).toHaveBeenCalledOnce();
      expect(owners.retryRecordingBrief).toHaveBeenCalledWith(ctx.sql,
        { orgId: org, instanceId, draftId: clipId, expectedClaimUUID, operatorId: "operator" });
      expect(JSON.parse(result!.content[0]!.text)).toEqual({ status: "queued", claimId: "brief-queued-id", providerExecutionMayBeUnresolved: true });
      expect(network).not.toHaveBeenCalled(); expect(owners.retryVideoTeardown).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it.each([undefined, false, "true"])("brief retry requires literal acknowledgement: %s", async acknowledgeUnresolvedOperation => {
    expect((await videoClaimsModule.handle("noelle_retry_recording_brief",
      { instanceId, draftId: clipId, expectedClaimUUID, acknowledgeUnresolvedOperation }, context()))?.isError).toBe(true);
    expect(owners.retryRecordingBrief).not.toHaveBeenCalled();
  });
  it("denies brief read-only and stale identities without false acknowledgement", async () => {
    const ctx = context(); vi.mocked(ctx.assertWritable).mockImplementation(() => { throw new Error("Read-only"); });
    const args = { instanceId, draftId: clipId, expectedClaimUUID, acknowledgeUnresolvedOperation: true };
    expect((await videoClaimsModule.handle("noelle_retry_recording_brief", args, ctx))?.isError).toBe(true);
    expect(owners.retryRecordingBrief).not.toHaveBeenCalled(); owners.retryRecordingBrief.mockResolvedValue(null);
    expect((await videoClaimsModule.handle("noelle_retry_recording_brief", args, context()))?.isError).toBe(true);
  });
  it("falls through for other tool names", async () => {
    expect(await videoClaimsModule.handle("unrelated", {}, context())).toBeNull();
  });
  it("registers all generation tools exactly once in the actual server module list", () => {
    for (const tool of videoClaimsModule.tools) expect(MODULES.flatMap(module => module.tools).filter(t => t.name === tool.name)).toHaveLength(1);
  });
});

const url = process.env.NOELLE_VIDEO_CLAIMS_MCP_TEST_DATABASE_URL;
describe.skipIf(!url)("Actual Video operator handler storage (native PostgreSQL)", () => {
  let sql: Sql; let instance: string; let clip: string; let claim: string;
  let real: typeof import("@noelle/runtime/video-teardown-claims-db");
  let briefs: typeof import("@noelle/runtime/video-recording-brief-db");
  let reads: typeof import("@noelle/runtime/video-generation-holds-db");
  const ctx = (readonly = false) => new NoelleContext(sql, { NOELLE_MCP_ORG: "mcp_owned",
    NOELLE_MCP_OPERATOR_SUB: "native-operator", NOELLE_MCP_READONLY: readonly } as Env);
  beforeAll(async () => {
    real = await vi.importActual("@noelle/runtime/video-teardown-claims-db");
    briefs = await vi.importActual("@noelle/runtime/video-recording-brief-db");
    reads = await vi.importActual("@noelle/runtime/video-generation-holds-db");
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    if ((await sql`select current_database() as name`)[0]?.name !== "noelle_video_claims_mcp_test")
      throw new Error("dedicated Video claims MCP database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0065_video_intern_watchlist.sql", "0066_video_intern_corpus.sql",
      "0067_video_intern_studio.sql", "0080_video_recording_briefs.sql", "0122_video_teardown_attempts.sql", "0123_video_recording_brief_attempts.sql"])
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    owners.retryVideoTeardown.mockImplementation(real.retryVideoTeardown);
    owners.retryRecordingBrief.mockImplementation(briefs.retryRecordingBrief);
    owners.listVideoGenerationHolds.mockImplementation(reads.listVideoGenerationHolds);
    await sql`truncate noelle.organizations cascade`;
    const orgId = String((await sql`insert into noelle.organizations(slug,name) values ('mcp_owned','Owned') returning id`)[0]!.id);
    await sql`insert into noelle.organizations(slug,name) values ('mcp_other','Other')`;
    instance = String((await sql`insert into noelle.agent_instances(org_id,role) values (${orgId},'video_intern') returning id`)[0]!.id);
    clip = String((await sql`insert into noelle.video_clips(org_id,agent_instance_id,external_id,author_handle)
      values (${orgId},${instance},'saved','example') returning id`)[0]!.id);
    const [saved] = await real.claimClipsForTeardown(sql, { instanceId: instance, orgId, limit: 1, dailyCap: 200 });
    claim = saved!.claim_id; await real.markTeardownDispatched(sql, saved!);
    await real.markTeardownClaimOutcome(sql, saved!, "unknown", "generation_unknown");
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  const retryArgs = () => ({ instanceId: instance, clipId: clip, expectedClaimUUID: claim, acknowledgeUnresolvedOperation: true });
  it("lists the exact hold and queues one attributed retry without network or learning output", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    try {
      const listed = await videoClaimsModule.handle("noelle_list_video_generation_holds", { instanceId: instance }, ctx());
      expect(JSON.parse(listed!.content[0]!.text).holds[0]).toMatchObject({ id: claim, status: "unknown", reason: "generation_unknown" });
      const result = await videoClaimsModule.handle("noelle_retry_video_teardown", retryArgs(), ctx());
      expect(result?.isError).not.toBe(true);
      const queued = JSON.parse(result!.content[0]!.text).claimId;
      expect(await sql`select id,status,operator_id,predecessor_id from noelle.video_teardown_attempts where status='queued'`)
        .toEqual([expect.objectContaining({ id: queued, operator_id: "native-operator", predecessor_id: claim })]);
      expect((await sql`select status from noelle.video_teardown_attempts where id=${claim}`)[0]?.status).toBe("superseded");
      expect(await sql`select id from noelle.video_teardowns`).toHaveLength(0); expect(network).not.toHaveBeenCalled();
      expect((await videoClaimsModule.handle("noelle_retry_video_teardown", retryArgs(), ctx()))?.isError).toBe(true);
    } finally { network.mockRestore(); }
  });
  it("rejects a foreign org, read-only context and missing acknowledgement without mutation", async () => {
    for (const [args, context] of [[{ ...retryArgs(), org: "mcp_other" }, ctx()], [retryArgs(), ctx(true)],
      [{ ...retryArgs(), acknowledgeUnresolvedOperation: false }, ctx()]] as const)
      expect((await videoClaimsModule.handle("noelle_retry_video_teardown", args, context))?.isError).toBe(true);
    expect(await sql`select id,status from noelle.video_teardown_attempts`).toEqual([{ id: claim, status: "unknown" }]);
  });
  it("lists a brief attempt UUID and queues its attributed retained successor through the actual handler", async () => {
    const [owner] = await sql<{ org_id: string }[]>`select org_id from noelle.agent_instances where id=${instance}`;
    const idea = String((await sql`insert into noelle.video_ideas(org_id,agent_instance_id,hook)
      values (${owner!.org_id},${instance},'Saved hook') returning id`)[0]!.id);
    const draft = String((await sql`insert into noelle.video_drafts(org_id,agent_instance_id,idea_id,status,script)
      values (${owner!.org_id},${instance},${idea},'ready','Saved body') returning id`)[0]!.id);
    const [saved] = await briefs.claimReadyDraftsForBrief(sql, instance, 1, owner!.org_id, { sourceEngine: "claude", model: "saved-model" });
    await briefs.markBriefDispatched(sql, saved!); await briefs.markBriefClaimOutcome(sql, saved!, "generation_unknown");
    const listed = await videoClaimsModule.handle("noelle_list_video_generation_holds", { instanceId: instance, kind: "recording_brief" }, ctx());
    expect(JSON.parse(listed!.content[0]!.text).holds).toEqual([expect.objectContaining({ id: saved!.claim_id, sourceId: draft })]);
    const args = { instanceId: instance, draftId: draft, expectedClaimUUID: saved!.claim_id, acknowledgeUnresolvedOperation: true };
    const network = vi.spyOn(globalThis, "fetch");
    try {
      expect((await videoClaimsModule.handle("noelle_retry_recording_brief", { ...args, org: "mcp_other" }, ctx()))?.isError).toBe(true);
      expect((await videoClaimsModule.handle("noelle_retry_recording_brief", args, ctx(true)))?.isError).toBe(true);
      const result = await videoClaimsModule.handle("noelle_retry_recording_brief", args, ctx()); expect(result?.isError).not.toBe(true);
      const queued = JSON.parse(result!.content[0]!.text).claimId;
      expect(await sql`select id,status,predecessor_id,operator_id from noelle.video_recording_brief_attempts where status='queued'`)
        .toEqual([{ id: queued, status: "queued", predecessor_id: saved!.claim_id, operator_id: "native-operator" }]);
      expect((await videoClaimsModule.handle("noelle_retry_recording_brief", args, ctx()))?.isError).toBe(true);
      expect(network).not.toHaveBeenCalled(); expect((await sql`select status from noelle.video_recording_briefs`)[0]?.status).toBe("queued");
    } finally { network.mockRestore(); }
  });

});

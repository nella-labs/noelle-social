import http from "node:http";
import https from "node:https";
import { Socket } from "node:net";
import { readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({
  user: true,
  org: true,
  parent: true,
  affected: 1,
  queries: [] as Array<{ text: string; values: unknown[] }>,
  revalidate: vi.fn(),
  image: vi.fn(),
  nativeSql: null as Sql | null,
}));
vi.mock("@/lib/db", () => ({
  sql: Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (state.nativeSql) return Reflect.apply(state.nativeSql, undefined, [strings, ...values]);
      const text = strings.join(" ");
      state.queries.push({ text, values });
      if (text.includes("select id from noelle.agent_instances"))
        return state.parent ? [{ id: "22222222-2222-4222-8222-222222222222" }] : [];
      if (text.includes("select graph_specs"))
        return [{ graph_specs: [{ kind: "bar_chart", title: "Stored visual" }] }];
      if (
        text.includes("update noelle.video_drafts") ||
        text.includes("update noelle.video_ideas") ||
        text.includes("update noelle.agent_instances")
      )
        return Object.assign(
          text.includes("returning") && state.affected
            ? [{ id: "33333333-3333-4333-8333-333333333333" }]
            : [],
          { count: state.affected },
        );
      if (text.includes("insert into noelle.video_ideas")) return Object.assign([], { count: 1 });
      throw new Error("Unexpected current Studio SQL");
    },
    { json: (value: unknown) => value },
  ),
}));
vi.mock("@/lib/queries", () => ({
  getCurrentUser: async () => (state.user ? { id: "55555555-5555-4555-8555-555555555555" } : null),
  getOrgBySlug: async () => (state.org ? { id: "11111111-1111-4111-8111-111111111111" } : null),
}));
vi.mock("next/cache", () => ({ revalidatePath: state.revalidate }));
vi.mock("@noelle/runtime", () => ({
  OrgMembershipError: class OrgMembershipError extends Error {},
  generateImageGemini: state.image,
}));
import {
  approveVideoIdea,
  dismissStudioItem,
  generateVideoIdeas,
  manualVideoIdea,
  markVideoDraftReady,
  removeDraftVisual,
  saveVideoDraftScript,
  saveVideoDraftStructure,
  scheduleVideoIdea,
  updateDraftVisual,
} from "./actions";
const common = { orgSlug: "workspace", draftId: "33333333-3333-4333-8333-333333333333" };
const commands = {
  generate: () => generateVideoIdeas({ orgSlug: common.orgSlug, mode: "single", count: 1 }),
  approve: () =>
    approveVideoIdea({ orgSlug: common.orgSlug, ideaId: "44444444-4444-4444-8444-444444444444" }),
  schedule: () =>
    scheduleVideoIdea({
      orgSlug: common.orgSlug,
      ideaId: "44444444-4444-4444-8444-444444444444",
      day: "2026-10-12",
    }),
  removeVisual: () => removeDraftVisual({ ...common, index: 0 }),
  updateVisual: () => updateDraftVisual({ ...common, index: 0, title: "Edited visual" }),
  dismissIdea: () =>
    dismissStudioItem({
      orgSlug: common.orgSlug,
      target: "idea",
      id: "44444444-4444-4444-8444-444444444444",
    }),
  script: () => saveVideoDraftScript({ ...common, script: "Operator script" }),
  beats: () =>
    saveVideoDraftStructure({
      ...common,
      structure: [{ tStart: 0, tEnd: 2, purpose: "hook", line: "Operator beat" }],
    }),
  ready: () => markVideoDraftReady({ ...common, editedScript: "Operator script" }),
  dismiss: () =>
    dismissStudioItem({ orgSlug: common.orgSlug, target: "draft", id: common.draftId }),
};
beforeEach(() => {
  Object.assign(state, { user: true, org: true, parent: true, affected: 1, queries: [] });
  state.revalidate.mockReset();
  state.image.mockReset();
  vi.spyOn(http, "request").mockImplementation(() => {
    throw new Error("HTTP forbidden in Studio action proof");
  });
  vi.spyOn(https, "request").mockImplementation(() => {
    throw new Error("HTTPS forbidden in Studio action proof");
  });
  if (!state.nativeSql) {
    vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("Socket forbidden in Studio action proof");
    });
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Fetch forbidden in Studio action proof");
    }),
  );
});
afterEach(() => {
  expect(state.image).not.toHaveBeenCalled();
  expect(http.request).not.toHaveBeenCalled();
  expect(https.request).not.toHaveBeenCalled();
  if (!state.nativeSql) expect(Socket.prototype.connect).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
for (const [name, action] of Object.entries(commands)) {
  test(`${name} acknowledges only an actual affected scoped row`, async () => {
    state.affected = 0;
    const receipt = await action();
    expect(receipt.ok).toBe(false);
    expect(state.revalidate).not.toHaveBeenCalled();
  });
  test(`${name} retains current successful scoped dispatch`, async () => {
    const receipt = await action();
    expect(receipt).toEqual({ ok: true });
    expect(state.revalidate).toHaveBeenCalledWith("/app/[orgSlug]/content", "page");
    const update = state.queries.find((q) => q.text.includes("update noelle."))!;
    expect(update.values).toContain("22222222-2222-4222-8222-222222222222");
    expect(update.values).toContain("11111111-1111-4111-8111-111111111111");
    if (["script", "beats", "ready", "dismiss", "removeVisual", "updateVisual"].includes(name))
      expect(update.values).toContain("33333333-3333-4333-8333-333333333333");
    if (["approve", "schedule", "dismissIdea"].includes(name))
      expect(update.values).toContain("44444444-4444-4444-8444-444444444444");
  });
}
test("missing auth rejects before SQL or invalidation", async () => {
  state.user = false;
  expect(await commands.script()).toEqual({ ok: false, error: "unauthenticated" });
  expect(state.queries).toEqual([]);
  expect(state.revalidate).not.toHaveBeenCalled();
});
test("an absent current Nova rejects before a draft mutation", async () => {
  state.parent = false;
  expect(await commands.beats()).toEqual({ ok: false, error: "not_found" });
  expect(state.queries).toHaveLength(1);
  expect(state.revalidate).not.toHaveBeenCalled();
});
test("current manual ideas dispatch as proposed rather than approved", async () => {
  expect(await manualVideoIdea({ orgSlug: "workspace", hook: "Operator hook" })).toEqual({
    ok: true,
  });
  const insert = state.queries.find((q) => q.text.includes("insert into noelle.video_ideas"))!;
  expect(insert.text).toContain("'proposed'");
  expect(insert.text).not.toContain("'approved'");
});

const nativeUrl = process.env.NOELLE_STUDIO_READY_TEST_DATABASE_URL;
describe.skipIf(!nativeUrl)("Studio ready script preservation (native PostgreSQL)", () => {
  let db: Sql | undefined;
  beforeAll(async () => {
    const url = new URL(nativeUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.pathname !== "/noelle_studio_ready_test"
    ) {
      throw new Error("Exact local noelle_studio_ready_test database required");
    }
    db = postgres(nativeUrl!, {
      max: 1,
      connect_timeout: 2,
      idle_timeout: 1,
      onnotice: () => {},
      connection: {
        statement_timeout: 2000,
        lock_timeout: 1000,
        application_name: "studio-ready-fixture",
      },
    });
    expect((await db`select current_database() as name`)[0]?.name).toBe("noelle_studio_ready_test");
    await db`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0067_video_intern_studio.sql"]) {
      await db.unsafe(
        await readFile(
          new URL(`../../../../../../../infra/cloudsql/schema/${name}`, import.meta.url),
          "utf8",
        ),
      );
    }
    state.nativeSql = db;
  });
  beforeEach(async () => {
    await db!`truncate noelle.organizations cascade`;
    await db!`insert into noelle.organizations(id,slug,name)
      values ('11111111-1111-4111-8111-111111111111','workspace','Studio')`;
    await db!`insert into noelle.agent_instances(id,org_id,role)
      values ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','video_intern')`;
    await db!`insert into noelle.video_ideas(id,org_id,agent_instance_id,hook)
      values ('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222','Studio idea')`;
    await db!`insert into noelle.video_drafts(id,org_id,agent_instance_id,idea_id,script)
      values (${common.draftId},'11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444','Original script')`;
  });
  afterAll(async () => {
    state.nativeSql = null;
    await db?.end();
    const url = new URL(nativeUrl!);
    url.pathname = "/postgres";
    const observer = postgres(url.toString(), { max: 1, connect_timeout: 2, onnotice: () => {} });
    try {
      expect(
        Number(
          (
            await observer`select count(*) as count from pg_stat_activity
        where datname = 'noelle_studio_ready_test'`
          )[0]?.count,
        ),
      ).toBe(0);
    } finally {
      await observer.end();
    }
  });
  async function stored() {
    return (
      await db!`select final_script, status from noelle.video_drafts where id = ${common.draftId}`
    )[0];
  }
  test("Save then Ready without another edit preserves the saved script", async () => {
    expect(await saveVideoDraftScript({ ...common, script: "Saved operator script" })).toEqual({
      ok: true,
    });
    expect((await stored())?.final_script).toBe("Saved operator script");
    expect(await markVideoDraftReady(common)).toEqual({ ok: true });
    expect(await stored()).toMatchObject({
      final_script: "Saved operator script",
      status: "ready",
    });
  });
  test("Ready without an edit retains an original null script", async () => {
    expect(await markVideoDraftReady(common)).toEqual({ ok: true });
    expect(await stored()).toMatchObject({ final_script: null, status: "ready" });
  });
  for (const editedScript of ["", "Replacement script"]) {
    test(`Ready accepts an explicit ${editedScript ? "replacement" : "empty"} script`, async () => {
      await saveVideoDraftScript({ ...common, script: "Earlier saved script" });
      expect(await markVideoDraftReady({ ...common, editedScript })).toEqual({ ok: true });
      expect(await stored()).toMatchObject({ final_script: editedScript, status: "ready" });
    });
  }
  test("Ready refuses a scoped zero-row write without invalidation", async () => {
    state.revalidate.mockClear();
    expect(
      await markVideoDraftReady({ ...common, draftId: "66666666-6666-4666-8666-666666666666" }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(state.revalidate).not.toHaveBeenCalled();
    expect(await stored()).toMatchObject({ final_script: null, status: "draft" });
  });
});

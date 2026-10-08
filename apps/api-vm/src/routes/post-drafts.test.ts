import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { resetEnvForTests } from "../env.js";
import { postDrafts } from "./post-drafts.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const IDEA_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

type Platform = "linkedin" | "x";

function render(strings: TemplateStringsArray, values: unknown[]) {
  let text = "";
  for (let i = 0; i < strings.length; i += 1) {
    text += strings[i];
    if (i < values.length) text += `<<v${i}>>`;
  }
  return text;
}

function makeDb(opts: { role?: string } = {}) {
  const idea = {
    org_id: ORG_ID,
    agent_instance_id: AGENT_ID,
    role: opts.role ?? "linkedin_intern",
    generation_request_id: REQUEST_ID as string | null,
    generation_review_required: true,
  };
  const request = {
    id: REQUEST_ID,
    platforms: ["linkedin", "x"],
    review_required: true,
    status: "pending",
  };
  const drafts: Array<{ platform: Platform; generation_request_id: string | null; quality_passed: boolean | null; verifier_meta: unknown }> = [];
  const requestStatusWrites: string[] = [];
  const scheduleActions: string[] = [];
  const insertQueries: string[] = [];

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = render(strings, values);
    const lower = text.toLowerCase().replace(/\s+/g, " ").replace(/\s*=\s*/g, " = ");

    if (lower.includes("select role from noelle.agent_instances")) return [{ role: idea.role }];
    if (lower.includes("select status from noelle.post_ideas")) return [{ status: "drafted" }];
    if (lower.includes("select id from noelle.post_drafts")) return [{ id: "draft" }];

    if (lower.includes("from noelle.post_ideas pi") && lower.includes("join noelle.agent_instances")) {
      return [{ org_id: idea.org_id, agent_instance_id: idea.agent_instance_id, role: idea.role }];
    }

    if (lower.includes("insert into noelle.post_drafts")) {
      insertQueries.push(text);
      drafts.push({
        platform: values[6] as Platform,
        generation_request_id: (values[15] as string | null | undefined) ?? null,
        quality_passed: (values[13] as boolean | null | undefined) ?? null,
        verifier_meta: values[14] ?? null,
      });
      return [{ id: `draft-${drafts.length}` }];
    }

    if (lower.includes("select id, platforms, review_required") && lower.includes("from noelle.post_generation_requests")) {
      const requestId = values[1] as string;
      const matching = drafts.filter((draft) => draft.generation_request_id === requestId);
      const seen = new Set(matching.map((draft) => draft.platform));
      return [{
        platforms: request.platforms,
        review_required: request.review_required,
        generation_complete: values[0] === true,
        missing: request.platforms.filter((platform) => !seen.has(platform as Platform)),
        failed: matching.some((draft) => draft.quality_passed === false),
        unreviewed: matching.some((draft) => draft.quality_passed === null || draft.verifier_meta === null),
      }];
    }

    if (lower.includes("select id") && lower.includes("from noelle.post_generation_requests")) {
      return values.includes(request.id) && values.includes(idea.org_id) && values.includes(idea.agent_instance_id) && values.includes(IDEA_ID)
        ? [{ id: request.id }]
        : [];
    }

    if (lower.includes("update noelle.post_generation_requests")) {
      request.status = values[0] as string;
      requestStatusWrites.push(request.status);
      return [];
    }

    if (lower.includes("select distinct window_source from noelle.content_schedule_slots")) {
      scheduleActions.push("read-existing-slots");
      return [];
    }

    if (lower.includes("select max(slot_at) as last_at from noelle.content_schedule_slots")) {
      scheduleActions.push("read-last-slot");
      return [{ last_at: null }];
    }

    if (lower.includes("insert into noelle.content_schedule_slots")) {
      scheduleActions.push(`insert-auto-slot:auto_publish=${String(values[6])}`);
      return [];
    }

    if (lower.includes("update noelle.post_drafts set status = 'dismissed'")) {
      scheduleActions.push("auto-dismiss-draft");
      return [];
    }

    if (lower.includes("update noelle.post_drafts") && lower.includes("stage = 'scheduled'")) {
      scheduleActions.push("mark-draft-scheduled");
      return [];
    }

    if (lower.includes("update noelle.post_ideas set status = 'ready'")) {
      scheduleActions.push("mark-idea-ready");
      return [];
    }

    if (lower.includes("update noelle.post_ideas") && lower.includes("generation_review_required")) {
      idea.generation_review_required = false;
      if (lower.includes("generation_request_id = null")) idea.generation_request_id = null;
      return [];
    }

    if (lower.includes("update noelle.post_ideas") && lower.includes("set status = 'drafted'")) return [];
    if (lower.includes("update noelle.content_schedule_slots")) {
      scheduleActions.push("bind-waiting-slot");
      return [];
    }

    return [];
  }) as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    json(value: unknown): unknown;
    begin<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
  };

  sql.json = (value: unknown) => value;
  sql.begin = (fn) => fn(sql);
  return { sql: sql as never, idea, drafts, requestStatusWrites, scheduleActions, insertQueries };
}

function draftPayload(platform: Platform, generationRequestId: string | null, opts: { generationComplete?: boolean; qualityPassed?: boolean } = {}) {
  return {
    ideaId: IDEA_ID,
    platform,
    body: `${platform} post`,
    charCount: 13,
    qualityScore: 0.91,
    qualityPassed: opts.qualityPassed ?? true,
    verifierMeta: {
      pass: true,
      scores: { voice: 0.91, grounding: 0.91, relevance: 0.91, format: 0.91 },
      reasons: ["ok"],
      attempts: 1,
    },
    generationRequestId,
    generationComplete: opts.generationComplete ?? false,
  };
}

describe("POST /api/post-drafts generation request correlation", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.NOELLE_DATABASE_URL = "postgres://noelle_app:test@127.0.0.1:5432/noelle?sslmode=require";
    process.env.NOELLE_HMAC_SECRET = "y".repeat(48);
    resetEnvForTests();
    resetDbClientForTests();
  });

  it("clears the idea request link only after the worker marks the final planned variant complete", async () => {
    const db = makeDb();
    __setDbClientForTests(db.sql);
    const app = new Hono().route("/", postDrafts);

    expect((await app.request("/api/post-drafts", { method: "POST", body: JSON.stringify(draftPayload("linkedin", REQUEST_ID)) })).status).toBe(200);
    expect(db.idea.generation_request_id).toBe(REQUEST_ID);
    expect(db.requestStatusWrites).toEqual(["drafting"]);

    expect((await app.request("/api/post-drafts", { method: "POST", body: JSON.stringify(draftPayload("x", REQUEST_ID)) })).status).toBe(200);
    expect(db.idea.generation_request_id).toBe(REQUEST_ID);
    expect(db.requestStatusWrites).toEqual(["drafting", "drafting"]);

    expect((await app.request("/api/post-drafts", { method: "POST", body: JSON.stringify(draftPayload("x", REQUEST_ID, { qualityPassed: false })) })).status).toBe(200);
    expect(db.idea.generation_request_id).toBe(REQUEST_ID);
    expect(db.requestStatusWrites).toEqual(["drafting", "drafting", "drafting"]);

    expect((await app.request("/api/post-drafts", { method: "POST", body: JSON.stringify(draftPayload("x", REQUEST_ID, { generationComplete: true })) })).status).toBe(200);
    expect(db.idea.generation_request_id).toBeNull();
    expect(db.idea.generation_review_required).toBe(false);
    expect(db.requestStatusWrites).toEqual(["drafting", "drafting", "drafting", "needs_review"]);

    expect((await app.request("/api/post-drafts", { method: "POST", body: JSON.stringify(draftPayload("linkedin", db.idea.generation_request_id)) })).status).toBe(200);
    expect(db.drafts.at(-1)?.generation_request_id).toBeNull();
    expect(db.requestStatusWrites).toEqual(["drafting", "drafting", "drafting", "needs_review"]);
  });

  it("saves explicit X generation requests without schedule reads, writes, or auto-dismissal", async () => {
    process.env.NOELLE_POST_AUTOSCHEDULE = "true";
    process.env.NOELLE_POST_AUTOSCHEDULE_AUTOPUBLISH = "true";
    process.env.NOELLE_POST_AUTOSCHEDULE_MIN_SCORE = "70";
    const db = makeDb({ role: "x_intern" });
    __setDbClientForTests(db.sql);
    const app = new Hono().route("/", postDrafts);

    const res = await app.request("/api/post-drafts", {
      method: "POST",
      body: JSON.stringify(draftPayload("x", REQUEST_ID, { generationComplete: true })),
    });

    expect(res.status).toBe(200);
    expect(db.drafts).toHaveLength(1);
    expect(db.drafts[0]).toMatchObject({ platform: "x", generation_request_id: REQUEST_ID });
    expect(db.scheduleActions).toEqual([]);
    expect(db.insertQueries[0]).toContain("and <<v2>>::uuid is null");
    expect(db.requestStatusWrites).toEqual(["drafting"]);
  });

  it("still auto-schedules ordinary X drafts for Vega when auto-publish is on", async () => {
    process.env.NOELLE_POST_AUTOSCHEDULE = "true";
    process.env.NOELLE_POST_AUTOSCHEDULE_AUTOPUBLISH = "true";
    process.env.NOELLE_POST_AUTOSCHEDULE_MIN_SCORE = "70";
    const db = makeDb({ role: "x_intern" });
    __setDbClientForTests(db.sql);
    const app = new Hono().route("/", postDrafts);

    const res = await app.request("/api/post-drafts", {
      method: "POST",
      body: JSON.stringify(draftPayload("x", null)),
    });

    expect(res.status).toBe(200);
    expect(db.drafts).toHaveLength(1);
    expect(db.drafts[0]).toMatchObject({ platform: "x", generation_request_id: null });
    expect(db.scheduleActions).toEqual([
      "bind-waiting-slot",
      "read-existing-slots",
      "read-last-slot",
      "insert-auto-slot:auto_publish=true",
      "mark-draft-scheduled",
      "mark-idea-ready",
    ]);
  });
});

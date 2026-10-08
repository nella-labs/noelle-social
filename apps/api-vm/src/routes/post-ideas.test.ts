import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { resetEnvForTests } from "../env.js";
import { postIdeas } from "./post-ideas.js";
import { resolveActiveInstanceForPlatform } from "../lib/auth.js";

vi.mock("../lib/auth.js", () => ({
  resolveActiveInstanceForPlatform: vi.fn(),
}));

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const X_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const LINKEDIN_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const BATCH_ID = "55555555-5555-4555-8555-555555555555";
const IDEA_ID = "66666666-6666-4666-8666-666666666666";

type Platform = "linkedin" | "x" | "reddit";
type RequestRow = {
  org_id: string;
  agent_instance_id: string;
  role: string;
  batch_id: string | null;
  require_review: boolean;
};
type InsertedIdea = {
  id: string;
  org_id: string;
  agent_instance_id: string;
  platform: Platform;
  batch_id: string | null;
  status: string;
};

function render(strings: TemplateStringsArray, values: unknown[]) {
  let text = "";
  for (let i = 0; i < strings.length; i += 1) {
    text += strings[i];
    if (i < values.length) text += `<<v${i}>>`;
  }
  return text;
}

function makeDb(opts: { request?: RequestRow | null } = {}) {
  const insertedIdeas: InsertedIdea[] = [];
  const requestQueries: string[] = [];

  const sql = ((first: TemplateStringsArray | InsertedIdea[], ...values: unknown[]) => {
    if (Array.isArray(first) && !("raw" in first)) {
      return { rows: first, columns: values };
    }

    const strings = first as TemplateStringsArray;
    const text = render(strings, values);
    const lower = text.toLowerCase();

    if (lower.includes("from noelle.ideation_requests ir")) {
      requestQueries.push(text);
      return Promise.resolve(opts.request ? [opts.request] : []);
    }

    if (lower.includes("insert into noelle.post_ideas")) {
      const helper = values.find((value): value is { rows: InsertedIdea[] } => {
        return typeof value === "object" && value !== null && "rows" in value;
      });
      insertedIdeas.push(...(helper?.rows ?? []));
      return Promise.resolve([]);
    }

    return Promise.resolve([]);
  }) as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    (rows: InsertedIdea[], ...columns: string[]): unknown;
    json(value: unknown): unknown;
  };

  sql.json = (value: unknown) => value;
  return { sql: sql as never, insertedIdeas, requestQueries };
}

function ideaPayload(opts: { id?: string; platform?: Platform; batchId?: string | null } = {}) {
  const platform = opts.platform ?? "x";
  return {
    id: opts.id ?? IDEA_ID,
    platform,
    targetPlatforms: [platform],
    hook: `${platform} hook`,
    thesis: `${platform} thesis`,
    inspirationRefs: [],
    batchId: opts.batchId ?? null,
  };
}

describe("POST /api/post-ideas ideation request ownership", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.NOELLE_DATABASE_URL =
      "postgres://noelle_app:test@127.0.0.1:5432/noelle?sslmode=require";
    process.env.NOELLE_HMAC_SECRET = "y".repeat(48);
    process.env.NOELLE_POST_AUTOSCHEDULE = "true";
    resetEnvForTests();
    resetDbClientForTests();
    vi.mocked(resolveActiveInstanceForPlatform).mockReset();
  });

  it("keeps explicit X ideation requests proposed even when Vega auto-schedule is on", async () => {
    const db = makeDb({
      request: {
        org_id: ORG_ID,
        agent_instance_id: X_AGENT_ID,
        role: "x_intern",
        batch_id: null,
        require_review: true,
      },
    });
    __setDbClientForTests(db.sql);
    const app = new Hono().route("/", postIdeas);

    const res = await app.request("/api/post-ideas", {
      method: "POST",
      body: JSON.stringify({
        platform: "x",
        ideationRequestId: REQUEST_ID,
        ideas: [ideaPayload()],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ idea_ids: [IDEA_ID] });
    expect(resolveActiveInstanceForPlatform).not.toHaveBeenCalled();
    expect(db.requestQueries).toHaveLength(1);
    expect(db.insertedIdeas).toHaveLength(1);
    expect(db.insertedIdeas[0]).toMatchObject({
      org_id: ORG_ID,
      agent_instance_id: X_AGENT_ID,
      platform: "x",
      status: "proposed",
    });
  });

  it("auto-approves request-bound X ideas when the ideation request does not require review", async () => {
    const db = makeDb({
      request: {
        org_id: ORG_ID,
        agent_instance_id: X_AGENT_ID,
        role: "x_intern",
        batch_id: null,
        require_review: false,
      },
    });
    __setDbClientForTests(db.sql);
    const app = new Hono().route("/", postIdeas);

    const res = await app.request("/api/post-ideas", {
      method: "POST",
      body: JSON.stringify({
        platform: "x",
        ideationRequestId: REQUEST_ID,
        ideas: [ideaPayload()],
      }),
    });

    expect(res.status).toBe(200);
    expect(resolveActiveInstanceForPlatform).not.toHaveBeenCalled();
    expect(db.insertedIdeas).toHaveLength(1);
    expect(db.insertedIdeas[0]).toMatchObject({
      agent_instance_id: X_AGENT_ID,
      status: "approved",
    });
  });

  it("still auto-approves ordinary X ideas when auto-schedule is on", async () => {
    vi.mocked(resolveActiveInstanceForPlatform).mockResolvedValue({
      org_id: ORG_ID,
      agent_instance_id: X_AGENT_ID,
      role: "x_intern",
    });
    const db = makeDb();
    __setDbClientForTests(db.sql);
    const app = new Hono().route("/", postIdeas);

    const res = await app.request("/api/post-ideas", {
      method: "POST",
      body: JSON.stringify({ platform: "x", ideas: [ideaPayload()] }),
    });

    expect(res.status).toBe(200);
    expect(resolveActiveInstanceForPlatform).toHaveBeenCalledWith("x");
    expect(db.requestQueries).toHaveLength(0);
    expect(db.insertedIdeas).toHaveLength(1);
    expect(db.insertedIdeas[0]).toMatchObject({
      org_id: ORG_ID,
      agent_instance_id: X_AGENT_ID,
      status: "approved",
    });
  });

  it("rejects an unknown explicit ideation request without inserting ideas", async () => {
    const db = makeDb({ request: null });
    __setDbClientForTests(db.sql);
    const app = new Hono().route("/", postIdeas);

    const res = await app.request("/api/post-ideas", {
      method: "POST",
      body: JSON.stringify({
        platform: "x",
        ideationRequestId: REQUEST_ID,
        ideas: [ideaPayload()],
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "ideation_request_not_found" });
    expect(resolveActiveInstanceForPlatform).not.toHaveBeenCalled();
    expect(db.insertedIdeas).toHaveLength(0);
  });

  it("rejects an explicit ideation request owned by another platform role", async () => {
    const db = makeDb({
      request: {
        org_id: ORG_ID,
        agent_instance_id: LINKEDIN_AGENT_ID,
        role: "linkedin_intern",
        batch_id: null,
        require_review: true,
      },
    });
    __setDbClientForTests(db.sql);
    const app = new Hono().route("/", postIdeas);

    const res = await app.request("/api/post-ideas", {
      method: "POST",
      body: JSON.stringify({
        platform: "x",
        ideationRequestId: REQUEST_ID,
        ideas: [ideaPayload()],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "ideation_request_platform_mismatch" });
    expect(db.insertedIdeas).toHaveLength(0);
  });

  it("rejects an explicit batch request when idea batch ids do not match", async () => {
    const db = makeDb({
      request: {
        org_id: ORG_ID,
        agent_instance_id: X_AGENT_ID,
        role: "x_intern",
        batch_id: BATCH_ID,
        require_review: true,
      },
    });
    __setDbClientForTests(db.sql);
    const app = new Hono().route("/", postIdeas);

    const res = await app.request("/api/post-ideas", {
      method: "POST",
      body: JSON.stringify({
        platform: "x",
        ideationRequestId: REQUEST_ID,
        ideas: [ideaPayload({ batchId: "different-batch" })],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "ideation_request_batch_mismatch" });
    expect(db.insertedIdeas).toHaveLength(0);
  });
});

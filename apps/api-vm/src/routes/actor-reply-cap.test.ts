import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { resetEnvForTests } from "../env.js";
import { actorReplyCap, resolveBrowserReplyCap } from "./actor-reply-cap.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const headers = { authorization: "Bearer actor-test", "content-type": "application/json" };

function fakeDb(role?: "linkedin_intern" | "x_intern") {
  let cap: number | null = null;
  let replies = 20;
  let minimum: number | null = null;
  let day: string | null = null;
  let effective: number | null = null;
  const queries: string[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").toLowerCase();
    queries.push(query);
    if (query.startsWith("set local") || query.trim() === "for update" || query.trim() === "") return [];
    if (query.includes("from noelle.agent_instances")) {
      const requestedRole = query.includes("role='x_intern'") ? "x_intern" : values[2];
      return values[0] === instanceId && values[1] === orgId && (!role || requestedRole === role)
        ? [{ id: instanceId, actuator_daily_reply_cap: cap, actuator_daily_reply_cap_min: minimum,
          sampled_day: day, actuator_daily_reply_cap_effective: effective, today: "2026-10-07" }] : [];
    }
    if (query.includes("update noelle.agent_instances")) {
      if (query.includes("actuator_daily_reply_cap_min=")) {
        if (values[4] !== instanceId || values[5] !== orgId || role && role !== "x_intern") return [];
        [cap, minimum, day, effective] = values.slice(0, 4) as [number | null, number | null, string | null, number | null];
        return [];
      }
      if (values[1] !== instanceId || values[2] !== orgId || role && values[3] !== role) return [];
      cap = values[0] as number | null;
      return [{ actuator_daily_reply_cap: cap }];
    }
    if (query.includes("from noelle.linkedin_activity") || query.includes("from noelle.x_activity")) {
      return [{ sent: replies, n: replies }];
    }
    throw new Error(`unexpected query ${query}`);
  }) as never;
  Object.assign(sql, { begin: (fn: (tx: unknown) => Promise<unknown>) => fn(sql) });
  return { sql, setReplies(n: number) { replies = n; }, cap: () => cap, queries };
}

describe("browser reply cap", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.NOELLE_DATABASE_URL = "postgres://test:test@127.0.0.1:5432/test";
    process.env.NOELLE_HMAC_SECRET = "h".repeat(48);
    process.env.NOELLE_ACTUATOR_TOKEN = "actor-test";
    process.env.NOELLE_ACTUATOR_ORG_ID = orgId;
    process.env.NOELLE_X_ACTUATOR_DAILY_WRITE_CAP = "90";
    resetEnvForTests();
    resetDbClientForTests();
  });
  const app = () => new Hono().route("/", actorReplyCap);
  const url = (platform: string, id = instanceId) =>
    `/api/actuator/reply-cap?platform=${platform}&instanceId=${id}`;

  it("keeps the existing default until an operator sets a cap", () => {
    expect(resolveBrowserReplyCap("linkedin", null)).toBeNull();
    expect(resolveBrowserReplyCap("x", null)).toBe(90);
    expect(resolveBrowserReplyCap("x", 80)).toBe(80);
    expect(resolveBrowserReplyCap("linkedin", 0)).toBe(0);
  });

  it("counts browser replies only, reads the live cap, and changes it without a restart", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const first = await app().request(url("x"), { headers });
    expect(await first.json()).toEqual({ sent: 20, cap: 90, remaining: 70 });
    const saved = await app().request(url("x"), {
      method: "POST", headers, body: JSON.stringify({ cap: 80 }),
    });
    expect(await saved.json()).toEqual({ sent: 20, cap: 80, remaining: 60 });
    expect(db.cap()).toBe(80);
    expect(db.queries.some((query) => query.includes("from noelle.x_activity") && query.includes("type = 'reply'"))).toBe(true);
    db.setReplies(23);
    expect(await (await app().request(url("x"), { headers })).json())
      .toEqual({ sent: 23, cap: 80, remaining: 57 });
  });

  it("counts LinkedIn comments without counting DMs as replies", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    expect(await (await app().request(url("linkedin"), { headers })).json())
      .toEqual({ sent: 20, cap: null, remaining: null });
    expect(db.queries.some((query) => query.includes("from noelle.linkedin_activity") && query.includes("type = 'comment'"))).toBe(true);
    expect(db.queries.every((query) => !query.includes("type in ('comment', 'dm')"))).toBe(true);
  });

  it("starts daily variation at the configured ceiling", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const response = await app().request(url("x"), {
      method: "POST", headers, body: JSON.stringify({ cap: 140, minimum: 80 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sent: 20, cap: 140, remaining: 120, configuredCap: 140, minimum: 80,
    });
  });

  it("rejects a daily minimum above the configured ceiling", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const response = await app().request(url("x"), {
      method: "POST", headers, body: JSON.stringify({ cap: 140, minimum: 150 }),
    });
    expect(response.status).toBe(400);
    expect(db.cap()).toBeNull();
  });

  it("rejects another tenant, wrong platform, invalid cap, and missing token", async () => {
    const db = fakeDb("x_intern"); __setDbClientForTests(db.sql);
    expect((await app().request(url("linkedin", otherId), { headers })).status).toBe(403);
    expect((await app().request(url("linkedin"), { headers })).status).toBe(403);
    expect((await app().request(url("reddit"), { headers })).status).toBe(400);
    expect((await app().request(url("x"), { method: "POST", headers, body: JSON.stringify({ cap: 501 }) })).status).toBe(400);
    expect((await app().request(url("x"), { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect(db.cap()).toBeNull();
  });
});

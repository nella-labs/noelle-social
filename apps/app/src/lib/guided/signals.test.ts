import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * `signals.ts` is where both of this feature's real bugs lived: an Apify
 * predicate that disagreed with the workers, and an agent query that counted a
 * waitlist placeholder as a hire. Neither is reachable from `plan.test.ts`,
 * because both live in SQL. These tests pin the SQL.
 */

const queries: string[] = [];
const assertOrgMember = vi.fn(async () => undefined);
let currentUser: { id: string } | null = { id: "user_1" };
let rejectedRead: string | null = null;

/** Rows returned per query, keyed by a substring of the SQL. */
const rowsFor = (text: string): unknown[] => {
  if (text.includes("as discovered_any")) {
    return [{ discovered_any: true, drafted_any: false, actioned_any: false }];
  }
  if (text.includes("from noelle.vaults")) return [{ wizard_stage: "light" }];
  if (text.includes("kind = 'apify'")) return [{ ok: true }];
  if (text.includes("from noelle.agent_instances")) {
    return [
      {
        id: "vega-id",
        role: "x_intern",
        display_name: "Vega",
        status: "provisioning_alpha",
        reply_send_enabled: false,
        has_targeting: false,
      },
    ];
  }
  return [];
};

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    const text = strings.reduce((out, part, index) => out + part + (index < parameters.length
      ? (typeof parameters[index] === "object" && parameters[index] !== null && "text" in parameters[index]
        ? String((parameters[index] as { text: string }).text) : " ? ") : ""), "");
    return { text, then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) {
      queries.push(text);
      const result = rejectedRead && text.includes(rejectedRead)
        ? Promise.reject(new Error("inert guided read unavailable")) : Promise.resolve(rowsFor(text));
      return result.then(resolve, reject);
    } };
  },
  pgOrgMembersClient: () => ({}),
}));

vi.mock("@noelle/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("@noelle/runtime")>(),
  assertOrgMember: (...args: unknown[]) => assertOrgMember(...(args as [])),
}));

vi.mock("@/lib/auth-cookie", () => ({
  getUserFromCookies: async () => currentUser,
}));

const { loadGuidedSignals } = await import("./signals");

const load = () =>
  loadGuidedSignals({ orgId: "org_1", pendingApprovals: 2, xPostingReady: false });

beforeEach(() => {
  queries.length = 0;
  assertOrgMember.mockClear();
  currentUser = { id: "user_1" };
  rejectedRead = null;
});

/** The SQL with `--` comments stripped, so prose about a predicate never passes for the predicate. */
const stripComments = (q: string) => q.replace(/--[^\n]*/g, "");

const apifyQuery = () => stripComments(queries.find((q) => q.includes("kind = 'apify'"))!);
const agentQuery = () => stripComments(queries.find((q) => q.includes("from noelle.agent_instances"))!);

describe("tenancy", () => {
  test("asserts org membership — Cloud SQL has no RLS", async () => {
    await load();
    expect(assertOrgMember).toHaveBeenCalledTimes(1);
  });

  test("signed-out state is unavailable and queries nothing", async () => {
    currentUser = null;
    await expect(load()).rejects.toThrow(/unavailable/i);
    expect(queries).toHaveLength(0);
    expect(assertOrgMember).not.toHaveBeenCalled();
  });
});

test.each(["from noelle.vaults", "kind = 'apify'", "ai.status <> 'retired'", "as discovered_any"])("failed %s read rejects rather than resetting progress", async query => {
  rejectedRead = query; await expect(load()).rejects.toThrow("inert guided read unavailable");
});

describe("apify token predicate matches the workers", () => {
  test("requires in_use — a pasted token lands spare and no worker reads it", async () => {
    await load();
    expect(apifyQuery()).toMatch(/\band in_use\b/);
  });

  test("excludes invalid tokens", async () => {
    await load();
    expect(apifyQuery()).toMatch(/invalid_at is null/);
  });

  test("an exhausted token with no scheduled retry is NOT live", async () => {
    await load();
    const q = apifyQuery();
    expect(q).toMatch(/exhausted_at is null or retry_at <= now\(\)/);
    // `or retry_at is null` would resurrect a token the workers skip.
    expect(q).not.toMatch(/retry_at is null/);
  });
});

describe("agent query", () => {
  test("drops retired agents but keeps waitlist placeholders for the hire note", async () => {
    await load();
    const q = agentQuery();
    expect(q).toMatch(/status <> 'retired'/);
    expect(q).not.toMatch(/provisioning_alpha/);
  });

  test("resolves targeting in one query, per role, with no interpolated table name", async () => {
    await load();
    const q = agentQuery();
    for (const t of [
      "noelle.x_watchlist",
      "noelle.linkedin_watchlist",
      "noelle.reddit_watchlist",
      "noelle.video_watchlist_sources",
    ]) {
      expect(q).toContain(t);
    }
    // One agent query, not one per agent.
    expect(queries.filter((x) => x.includes("from noelle.agent_instances ai"))).toHaveLength(1);
  });

  test("a provisioning_alpha row survives into signals so the registry can explain it", async () => {
    const s = await load();
    expect(s.agents).toHaveLength(1);
    expect(s.agents[0].status).toBe("provisioning_alpha");
  });
});

describe("snapshot shape", () => {
  test("carries the caller's pendingApprovals and xPostingReady through untouched", async () => {
    const s = await load();
    expect(s.pendingApprovals).toBe(2);
    expect(s.xPostingReady).toBe(false);
    expect(s.vaultStage).toBe("light");
    expect(s.hasApifyToken).toBe(true);
    expect(s.discoveredAny).toBe(true);
    expect(s.draftedAny).toBe(false);
  });
});

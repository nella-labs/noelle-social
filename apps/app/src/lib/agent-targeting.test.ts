import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// applyTargetingChange branches on the agent instance role and writes the
// matching watchlist table (x_intern → noelle.x_watchlist, linkedin_intern →
// noelle.linkedin_watchlist_people) plus an optional mission update. These
// tests mock the SQL client + org/auth queries so we can assert WHICH queries
// run for each role and that tenancy is enforced (wrong-org instance → not
// found, no writes).
// ---------------------------------------------------------------------------

interface Captured {
  text: string;
  values: unknown[];
}

// Captured top-level + transaction queries, in order.
let queries: Captured[] = [];
// Role the next `select role from noelle.agent_instances` returns. null =
// instance not in org (tenancy miss).
let instanceRole: string | null = "x_intern";

function reconstruct(strings: TemplateStringsArray, exprs: unknown[]): Captured {
  let text = "";
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < exprs.length) text += ` $${i} `;
  }
  return { text: text.replace(/\s+/g, " ").trim(), values: exprs };
}

// A tagged-template SQL fake. Used as a tag (sql`...`) it captures the query
// into the shared ordered `queries` array and resolves the role lookup. Used as
// a function (sql(rows, ...cols)) — the column-list insert helper — it returns a
// sentinel the insert interpolates; we only need it not to throw.
function tag(strings: TemplateStringsArray | unknown, ...exprs: unknown[]): unknown {
  if (Array.isArray((strings as TemplateStringsArray)?.raw)) {
    const cap = reconstruct(strings as TemplateStringsArray, exprs);
    queries.push(cap);
    if (cap.text.startsWith("select role from noelle.agent_instances")) {
      return Promise.resolve(instanceRole === null ? [] : [{ role: instanceRole }]);
    }
    if (cap.text.startsWith("insert into noelle.x_watchlist")) {
      const columns = exprs.find((value) => value && typeof value === "object" && "__cols" in value) as { rows: { kind: string }[] };
      return Promise.resolve(columns.rows.map(({ kind }) => ({ kind })));
    }
    if (cap.text.startsWith("insert into noelle.linkedin_watchlist_people")) {
      const people = exprs.find(Array.isArray) as string[];
      return Promise.resolve(people.map((id) => ({ id })));
    }
    if (/^(delete|update)\b/.test(cap.text)) return Promise.resolve([{ id: "changed" }]);
    return Promise.resolve([]);
  }
  return { __cols: true, rows: strings };
}

vi.mock("@/lib/db", () => {
  const sql = tag as unknown as {
    (strings: TemplateStringsArray, ...exprs: unknown[]): Promise<unknown[]>;
    begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  // tx is the same fake; transaction queries land in the same ordered array.
  sql.begin = async (fn: (tx: unknown) => Promise<unknown>) => fn(tag);
  return { sql };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/queries", () => ({
  getCurrentUser: async () => ({ id: "user_1", email: "u@example.com" }),
  getOrgBySlug: async (slug: string) =>
    slug === "operator" ? { id: "org_1", slug: "operator" } : null,
}));

// Import AFTER the mocks are registered.
const { applyTargetingChange } = await import("./agent-targeting");

beforeEach(() => {
  queries = [];
  instanceRole = "x_intern";
});
afterEach(() => {
  vi.clearAllMocks();
});

const BASE = {
  orgSlug: "operator",
  instanceId: "11111111-1111-1111-1111-111111111111",
};

describe("applyTargetingChange — linkedin_intern branch", () => {
  beforeEach(() => {
    instanceRole = "linkedin_intern";
  });

  it("inserts people into linkedin_watchlist_people (slug-normalised) and updates the mission", async () => {
    const res = await applyTargetingChange({
      ...BASE,
      proposal: {
        mission: "focus on YC founders",
        addPeople: ["https://www.linkedin.com/in/jane-doe/", "john-smith"],
      },
    });

    expect(res.ok).toBe(true);
    expect(res.applied).toMatchObject({
      addedPeople: 2,
      removedPeople: 0,
      addedHandles: 0,
      addedKeywords: 0,
      missionChanged: true,
    });

    const texts = queries.map((q) => q.text);
    // Mission update ran.
    expect(texts.some((t) => /update noelle.agent_instances set objective/.test(t))).toBe(true);
    // People insert targeted the LinkedIn table, not x_watchlist.
    expect(texts.some((t) => /insert into noelle.linkedin_watchlist_people/.test(t))).toBe(true);
    expect(texts.some((t) => /noelle.x_watchlist/.test(t))).toBe(false);

    const insert = queries.find((q) => /insert into noelle.linkedin_watchlist_people/.test(q.text));
    expect(insert?.values).toContainEqual(["jane-doe", "john-smith"]);
  });

  it("deletes people by public_id and reports counts", async () => {
    const res = await applyTargetingChange({
      ...BASE,
      proposal: { removePeople: ["https://linkedin.com/in/recruiter-bob"] },
    });
    expect(res.ok).toBe(true);
    expect(res.applied).toMatchObject({ removedPeople: 1, addedPeople: 0, missionChanged: false });

    const del = queries.find((q) =>
      /delete from noelle.linkedin_watchlist_people/.test(q.text),
    );
    expect(del).toBeTruthy();
    // Deletes by normalised public_id list.
    expect(del?.values).toContainEqual(["recruiter-bob"]);
  });
});

describe("applyTargetingChange — x_intern branch (unchanged)", () => {
  it("writes x_watchlist and never touches the LinkedIn table", async () => {
    instanceRole = "x_intern";
    const res = await applyTargetingChange({
      ...BASE,
      proposal: { addHandles: ["@levelsio"], addKeywords: ["ai agents"] },
    });
    expect(res.ok).toBe(true);
    expect(res.applied).toMatchObject({
      addedHandles: 1,
      addedKeywords: 1,
      addedPeople: 0,
      removedPeople: 0,
    });
    const texts = queries.map((q) => q.text);
    expect(texts.some((t) => /insert into noelle.x_watchlist/.test(t))).toBe(true);
    expect(texts.some((t) => /linkedin_watchlist_people/.test(t))).toBe(false);
  });
});

describe("applyTargetingChange — tenancy", () => {
  it("returns not_found and writes nothing when the instance isn't in the org", async () => {
    instanceRole = null; // role lookup returns no row
    const res = await applyTargetingChange({
      ...BASE,
      proposal: { addPeople: ["jane-doe"] },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not_found");
    // Only the role lookup ran — no insert/update/delete.
    const writes = queries.filter((q) => /^(insert|update|delete)\b/.test(q.text));
    expect(writes).toHaveLength(0);
  });

  it("returns not_found when the org slug is unknown", async () => {
    const res = await applyTargetingChange({
      orgSlug: "ghost",
      instanceId: BASE.instanceId,
      proposal: { addPeople: ["jane-doe"] },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not_found");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgMembershipError } from "@noelle/runtime";

interface Captured {
  text: string;
  values: unknown[];
}

let queries: Captured[] = [];
let selectRows: Array<{ lane_config: unknown }> = [];
let updateRows: Array<{ id: string }> = [];
let currentUser: { id: string } | null = { id: "user_1" };
let orgResult: { id: string; slug: string } | null = { id: "org-1", slug: "operator" };
let orgThrows = false;

function reconstruct(strings: TemplateStringsArray, exprs: unknown[]): Captured {
  let text = "";
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < exprs.length) text += ` $${i} `;
  }
  return { text: text.replace(/\s+/g, " ").trim(), values: exprs };
}

const sqlTag = Object.assign(
  function tag(strings: TemplateStringsArray | unknown, ...exprs: unknown[]): unknown {
    if (Array.isArray((strings as TemplateStringsArray)?.raw)) {
      const q = reconstruct(strings as TemplateStringsArray, exprs);
      queries.push(q);
      if (
        /update noelle\.agent_instances/.test(q.text) &&
        q.values.some((value) => value instanceof Promise)
      ) {
        return Promise.reject(new Error('syntax error at or near "linkedin_intro_dm_enabled"'));
      }
      if (/select lane_config from noelle\.agent_instances/.test(q.text)) {
        return Promise.resolve(selectRows);
      }
      if (/update noelle\.agent_instances/.test(q.text)) {
        return Promise.resolve(updateRows);
      }
      return Promise.resolve([]);
    }
    return { __sqlHelper: strings };
  },
  {
    json: (value: unknown) => ({ __json: value }),
  },
);

vi.mock("@/lib/db", () => ({ sql: sqlTag }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/queries", () => ({
  getCurrentUser: async () => currentUser,
  getOrgBySlug: async (slug: string) => {
    if (orgThrows) throw new OrgMembershipError("user_1", "org-1");
    return orgResult && slug === orgResult.slug ? orgResult : null;
  },
}));

const { setLaneEnabled, setRelationshipDmsEnabled } = await import("./actions");
const { revalidatePath } = await import("next/cache");

const BASE = {
  orgSlug: "operator",
  instanceId: "11111111-1111-1111-1111-111111111111",
};

beforeEach(() => {
  queries = [];
  selectRows = [
    {
      lane_config: {
        replies: { enabled: false },
        dms: {
          enabled: true,
          intro_dms_enabled: true,
          relationship_dms_enabled: false,
        },
        posts: { enabled: true },
      },
    },
  ];
  updateRows = [{ id: BASE.instanceId }];
  currentUser = { id: "user_1" };
  orgResult = { id: "org-1", slug: "operator" };
  orgThrows = false;
});

afterEach(() => vi.clearAllMocks());

describe("setRelationshipDmsEnabled", () => {
  it("updates only the stored-context DM flag, preserving the other lane state", async () => {
    const res = await setRelationshipDmsEnabled({ ...BASE, enabled: true });
    expect(res).toEqual({ ok: true });

    const select = queries.find((q) =>
      /select lane_config from noelle\.agent_instances/.test(q.text),
    );
    const update = queries.find((q) => /update noelle\.agent_instances/.test(q.text));
    expect(select?.text).toMatch(/role in/);
    expect(update?.text).toMatch(/role in/);
    expect(select?.values).toContain(BASE.instanceId);
    expect(select?.values).toContain("org-1");

    const saved = update?.values.find(
      (value): value is { __json: { dms: { relationship_dms_enabled: boolean } } } =>
        typeof value === "object" && value !== null && "__json" in value,
    );
    expect(saved?.__json).toEqual({
      replies: { enabled: false },
      dms: {
        enabled: true,
        intro_dms_enabled: true,
        relationship_dms_enabled: true,
      },
      posts: { enabled: true },
    });
  });

  it("revalidates the agent detail page after saving", async () => {
    await setRelationshipDmsEnabled({ ...BASE, enabled: true });
    expect(revalidatePath).toHaveBeenCalledWith(
      "/app/[orgSlug]/agents/[instanceId]",
      "page",
    );
  });

  it("returns not_found and skips the update when no X or LinkedIn instance matches", async () => {
    selectRows = [];
    const res = await setRelationshipDmsEnabled({ ...BASE, enabled: true });
    expect(res).toEqual({
      ok: false,
      error: { code: "not_found", message: "Agent instance not found." },
    });
    expect(queries.some((q) => /update noelle\.agent_instances/.test(q.text))).toBe(false);
  });

  it("rejects unauthenticated and non-member callers before reading lane_config", async () => {
    currentUser = null;
    await expect(setRelationshipDmsEnabled({ ...BASE, enabled: true })).resolves.toEqual({
      ok: false,
      error: { code: "unauthenticated", message: "unauthenticated" },
    });
    expect(queries).toEqual([]);

    currentUser = { id: "user_1" };
    orgThrows = true;
    await expect(setRelationshipDmsEnabled({ ...BASE, enabled: true })).resolves.toEqual({
      ok: false,
      error: { code: "forbidden", message: "forbidden" },
    });
    expect(queries).toEqual([]);
  });
});

describe("setLaneEnabled", () => {
  it("leaves the intro-DM flag untouched when omitted", async () => {
    await expect(
      setLaneEnabled({
        ...BASE,
        lane: "dms",
        enabled: true,
      }),
    ).resolves.toEqual({ ok: true });

    const update = queries.find((q) => /update noelle\.agent_instances/.test(q.text));
    expect(update?.text).toContain("dm_autodraft_enabled");
    expect(update?.text).not.toContain("linkedin_intro_dm_enabled =");
    expect(update?.values).toContain(true);
    expect(update?.values.some((value) => value instanceof Promise)).toBe(false);
  });
});

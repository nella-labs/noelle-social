import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fresh,
  foreignInstance,
  foreignOrg,
  input,
  instance,
  lead,
  linkedin,
  org,
  reset,
  rows,
  setup,
  sql,
  top,
  unsupported,
  write,
} from "./playbooks.fixture.js";
const url = process.env.PLAYBOOKS_DATABASE_URL;
describe.skipIf(!url)("Playbook storage scope and provenance (native)", () => {
  beforeAll(() => setup(url!));
  beforeEach(reset);
  afterAll(async () => {
    await sql?.end();
    const inspector = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      await vi.waitFor(
        async () => {
          const [row] = await inspector`select count(*)::int as remaining from pg_stat_activity
        where datname=current_database() and application_name='playbooks-native'
          and backend_type='client backend'`;
          expect(row?.remaining).toBe(0);
        },
        { timeout: 5000, interval: 50 },
      );
    } finally {
      await inspector.end();
    }
  });
  async function waitForWriteLock() {
    await vi.waitFor(
      async () => {
        const [row] = await sql`select count(*)::int as waiting from pg_stat_activity
        where datname=current_database() and application_name='playbooks-native'
          and wait_event_type='Lock' and query like '%watchlist_playbooks%'`;
        expect(row?.waiting).toBe(1);
      },
      { timeout: 800, interval: 20 },
    );
  }
  it.each(["x", "linkedin"] as const)(
    "preserves a valid %s playbook and source provenance",
    async (platform) => {
      const owner = platform === "x" ? instance : linkedin;
      const id = await lead({ platform, instance: owner });
      await write(input([id], { platform, agentInstanceId: owner }));
      expect(await top({ platform, agentInstanceId: owner })).toMatchObject([
        { authorHandle: "builder" },
      ]);
      expect(await fresh({ platform, agentInstanceId: owner })).toEqual(new Set(["builder"]));
    },
  );
  it("does not insert contradictory organization and current owner", async () => {
    const id = await lead();
    await expect(write(input([id], { orgId: foreignOrg }))).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });
  it("does not overwrite a contradictory existing organization row on conflict", async () => {
    const id = await lead();
    await sql`insert into noelle.watchlist_playbooks(org_id,agent_instance_id,author_handle,structure_notes,sample_post_ids)
    values (${foreignOrg},${instance},'builder','Foreign structure',${[id]})`;
    await expect(write(input([id]))).rejects.toThrow();
    expect((await rows())[0]?.structure_notes).toBe("Foreign structure");
  });
  it("rejects an unsupported current owner role", async () => {
    const id = await lead({ instance: unsupported });
    await expect(write(input([id], { agentInstanceId: unsupported }))).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });
  it("hides a playbook with a soft organization mismatch from both readers", async () => {
    const id = await lead();
    await sql`insert into noelle.watchlist_playbooks(org_id,agent_instance_id,author_handle,sample_post_ids)
    values (${foreignOrg},${instance},'builder',${[id]})`;
    expect({ top: await top(), fresh: [...(await fresh())] }).toEqual({ top: [], fresh: [] });
  });
  it("rejects a requested organization that does not own the instance", async () => {
    const id = await lead({ org: foreignOrg, instance: foreignInstance });
    await write(input([id], { orgId: foreignOrg, agentInstanceId: foreignInstance }));
    expect({
      top: await top({ agentInstanceId: foreignInstance }),
      fresh: [...(await fresh({ agentInstanceId: foreignInstance }))],
    }).toEqual({ top: [], fresh: [] });
  });
  it("hides persisted playbooks after a current parent role change", async () => {
    const id = await lead();
    await write(input([id]));
    await sql`update noelle.agent_instances set role='other' where id=${instance}`;
    expect({ top: await top(), fresh: [...(await fresh())] }).toEqual({ top: [], fresh: [] });
  });
  it.each(["foreign-org", "foreign-instance", "platform", "author", "missing"])(
    "rejects %s source provenance",
    async (kind) => {
      const overrides =
        kind === "foreign-org"
          ? { org: foreignOrg }
          : kind === "foreign-instance"
            ? { org: foreignOrg, instance: foreignInstance }
            : kind === "platform"
              ? { platform: "linkedin" }
              : kind === "author"
                ? { author: "another" }
                : {};
      const id = kind === "missing" ? "no-such-external-id" : await lead(overrides);
      await expect(write(input([id]))).rejects.toThrow();
      expect(await rows()).toEqual([]);
    },
  );
  it("preserves the exact case-sensitive external ID", async () => {
    const id = await lead({ external: "SOURCE-ID-Case-Sensitive" });
    await write(input([id]));
    expect((await rows())[0]?.sample_post_ids).toEqual([id]);
  });
  it("hides a stored playbook whose source IDs now belong to another author", async () => {
    const id = await lead();
    await write(input([id]));
    await sql`update noelle.leads set author_handle='another' where external_id=${id}`;
    expect({ top: await top(), fresh: [...(await fresh())] }).toEqual({ top: [], fresh: [] });
  });
  it.each(["role", "org"])("rechecks committed parent %s after its write lock", async (kind) => {
    const id = await lead();
    if (kind === "org")
      await sql`update noelle.agent_instances set role='other' where id=${foreignInstance}`;
    let unlock!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const writer = sql.begin(async (tx) => {
      await tx`select id from noelle.agent_instances where id=${instance} for no key update`;
      if (kind === "role")
        await tx`update noelle.agent_instances set role='other' where id=${instance}`;
      else await tx`update noelle.agent_instances set org_id=${foreignOrg} where id=${instance}`;
      locked();
      await gate;
    });
    await acquired;
    let settled = false;
    const writing = write(input([id])).then(
      () => {
        settled = true;
        return { wrote: true };
      },
      (error) => {
        settled = true;
        return { error };
      },
    );
    try {
      await waitForWriteLock();
      expect(settled).toBe(false);
    } finally {
      unlock();
      await writer;
    }
    expect(await writing).toHaveProperty("error");
    expect(await rows()).toEqual([]);
  });
  it("preserves the normalized X author used by the existing measured sampler", async () => {
    const id = await lead({ author: "@Builder" });
    await write(input([id]));
    expect(await top()).toMatchObject([{ authorHandle: "builder" }]);
    expect(await fresh()).toEqual(new Set(["builder"]));
  });
  it("rechecks source ownership after a committed source row change", async () => {
    const id = await lead();
    let unlock!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const writer = sql.begin(async (tx) => {
      await tx`update noelle.leads set author_handle='another' where external_id=${id}`;
      locked();
      await gate;
    });
    await acquired;
    let settled = false;
    const writing = write(input([id])).then(
      () => {
        settled = true;
        return { wrote: true };
      },
      (error) => {

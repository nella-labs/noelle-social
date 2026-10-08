import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openXCredsFixture, xCredsForeignInstance, xCredsForeignOrg, xCredsInstance, xCredsOrg } from "./x-api.creds-fixture.js";

const membership = vi.hoisted(() => ({ allowed: true }));
vi.mock("../lib/auth.js", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/auth.js")>(),
  isOrgMember: async () => membership.allowed,
}));
const url = process.env.NOELLE_X_API_CREDS_TEST_DATABASE_URL;
describe.skipIf(!url)("X credentials and posting switch (dedicated PostgreSQL)", () => {
  let f: Awaited<ReturnType<typeof openXCredsFixture>>;
  beforeAll(async () => { f = await openXCredsFixture(url!); });
  beforeEach(async () => { membership.allowed = true; await f.reset(); });
  afterAll(async () => { await f?.close(); });

  it.each(["save", "replace", "delete"])("rolls back %s if the posting switch write fails", async action => {
    if (action !== "save") await f.connected();
    const before = await f.state();
    await f.rejectFlagWrite();
    expect((await (action === "delete" ? f.remove() : f.save())).status).toBe(500);
    expect(await f.state()).toEqual(before);
  });
  it("saves scoped OAuth credentials and enables the existing paused X intern", async () => {
    expect((await f.save({ handle: "new_handle" })).status).toBe(200);
    expect(await f.state()).toMatchObject({ enabled: true, tokens: [{ org_id: xCredsOrg, x_handle: "new_handle" }] });
    expect((await f.sql`select x_api_write_enabled from noelle.agent_instances where id=${xCredsForeignInstance}`)[0]?.x_api_write_enabled).toBe(false);
  });
  it("preserves the stored handle when replacement omits it", async () => {
    await f.connected();
    expect((await f.save()).status).toBe(200);
    expect((await f.state()).tokens[0]?.x_handle).toBe("old_handle");
  });
  it("makes disconnect idempotent and clears only the scoped posting switch", async () => {
    await f.connected();
    expect((await f.remove()).status).toBe(200);
    expect((await f.remove()).status).toBe(200);
    expect(await f.state()).toEqual({ enabled: false, tokens: [] });
  });
  it.each(["save", "delete"])("rejects a contradictory stored token owner on %s", async action => {
    await f.connected(xCredsForeignOrg);
    const before = await f.state();
    expect((await (action === "save" ? f.save() : f.remove())).status).toBe(409);
    expect(await f.state()).toEqual(before);
  });
  it.each([
    ["role", "save"], ["org", "save"], ["role", "delete"], ["org", "delete"],
  ])("rechecks a committed parent %s change before %s", async (changed, action) => {
    if (action === "delete") await f.connected();
    const before = await f.state();
    f.afterResolution(async () => {
      if (changed === "role") await f.sql`update noelle.agent_instances set role='linkedin_intern' where id=${xCredsInstance}`;
      else {
        await f.sql`update noelle.agent_instances set role='linkedin_intern' where id=${xCredsForeignInstance}`;
        await f.sql`update noelle.agent_instances set org_id=${xCredsForeignOrg} where id=${xCredsInstance}`;
      }
    });
    expect((await (action === "delete" ? f.remove() : f.save())).status).toBe(409);
    expect(await f.state()).toEqual(before);
  });
  it("keeps both writes behind the actual parent lock during disconnect", async () => {
    await f.connected();
    let release!: () => void;
    let locked!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const parent = f.sql.begin(async tx => {
      await tx`select id from noelle.agent_instances where id=${xCredsInstance} for no key update`;
      locked();
      await wait;
    });
    await ready;
    const removing = f.remove();
    try {
      await f.waitForBlockedWrite();
      expect((await f.state()).tokens).toHaveLength(1);
    } finally {
      release();
      await parent;
      expect((await removing).status).toBe(200);
    }
    expect(await f.state()).toEqual({ enabled: false, tokens: [] });
  });
  it("serializes eight concurrent saves and deletes without separating token and switch state", async () => {
    const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => i % 2 ? f.remove() : f.save()));
    expect(replies.every(reply => reply.status === 200)).toBe(true);
    const state = await f.state();
    expect(state.enabled).toBe(state.tokens.length > 0);
  });
  it("keeps denied membership free of token or switch changes", async () => {
    membership.allowed = false;
    expect((await f.save()).status).toBe(403);
    expect((await f.remove()).status).toBe(403);
    expect(await f.state()).toEqual({ enabled: false, tokens: [] });
  });
  it("preserves every other sending consent on save and disconnect", async () => {
    await f.sql`update noelle.agent_instances set send_enabled=true,auto_send_enabled=true,reply_send_enabled=true
      where id=${xCredsInstance}`;
    expect((await f.save()).status).toBe(200);
    expect((await f.remove()).status).toBe(200);
    expect((await f.sql`select send_enabled,auto_send_enabled,reply_send_enabled from noelle.agent_instances
      where id=${xCredsInstance}`)[0]).toEqual({ send_enabled: true, auto_send_enabled: true, reply_send_enabled: true });
  });
});

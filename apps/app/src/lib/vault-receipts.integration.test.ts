import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const state = vi.hoisted(() => ({ sql: null as unknown as Sql, revalidate: vi.fn(), lostRenameReceipt: false }));
const org = "00000000-0000-4000-8000-000000000001", foreign = "00000000-0000-4000-8000-000000000002";
const instanceId = "00000000-0000-4000-8000-000000000011", user = "00000000-0000-4000-8000-000000000099";
const conversationId = "00000000-0000-4000-8000-000000000100";
vi.mock("react", () => ({ cache: <T>(fn: T) => fn }));
vi.mock("@/lib/db", () => {
  const proxy = new Proxy(() => {}, {
    apply: (_target, receiver, args) => Reflect.apply(state.sql, receiver, args),
    get: (_target, property) => { const value = Reflect.get(state.sql, property); return typeof value === "function" ? value.bind(state.sql) : value; },
  });
  return { sql: proxy, readSql: proxy, pgOrgMembersClient: () => (query: string, params: unknown[]) => state.sql.unsafe(query, params as Parameters<Sql["unsafe"]>[1]) };
});
vi.mock("@/lib/auth-cookie", () => ({ getUserFromCookies: async () => ({ id: user }) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({}) }));
vi.mock("next/cache", () => ({ revalidatePath: state.revalidate }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    await actual.rename(...args);
    if (state.lostRenameReceipt) throw new Error("fixture lost rename receipt");
  } };
});
import { appendChatTurn, loadLatestChatConversation, loadChatTurnsForModel } from "./queries";
import { applyVaultEdit } from "./agent-vault";
import { bindVaultEdit } from "./agent-chat/proposal";
import { prepareVaultSnapshot } from "./vault-snapshot";
const url = process.env.NOELLE_VAULT_RECEIPTS_TEST_DATABASE_URL;
const repo = resolve(import.meta.dirname, "../../../..");
const proposal = { path: "voice-spec.md", content: "Stored proposed content.\r\n ", summary: "Keep factual rules." };
let dir = "";
beforeAll(async () => {
  if (!url) return;
  state.sql = postgres(url, { max: 1, onnotice: () => {} });
  expect((await state.sql`select current_database() as db`)[0]?.db).toBe("noelle_vault_receipts_test");
  await state.sql`drop schema if exists noelle cascade`;
  for (const name of ["0001_noelle_schema.sql", "0006_vaults.sql", "0064_agent_chat_history.sql"]) await state.sql.unsafe(readFileSync(join(repo, "infra/cloudsql/schema", name), "utf8"));
  dir = await mkdtemp(join(tmpdir(), "vault-receipts-"));
});
beforeEach(async () => {
  if (!url) return;
  vi.stubEnv("NOELLE_AUTH_MODE", "local"); vi.stubEnv("NOELLE_LOCAL_ORG_SLUG", "fixture"); vi.stubEnv("NOELLE_VAULT_DIR", dir);
  state.revalidate.mockReset();
  state.lostRenameReceipt = false;
  await state.sql`truncate noelle.organizations cascade`;
  await state.sql`insert into noelle.organizations(id,slug,name) values(${org},'fixture','Fixture'),(${foreign},'foreign','Foreign')`;
  await state.sql`insert into noelle.org_members(org_id,user_id) values(${org},${user}),(${foreign},${user})`;
  await state.sql`insert into noelle.agent_instances(id,org_id,role) values(${instanceId},${org},'cmo')`;
  await writeFile(join(dir, proposal.path), "Original source.\r\n ");
});
afterAll(async () => { vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }); await state.sql?.end({ timeout: 0 }); });
async function receipt(legacy = false) {
  const stored = legacy ? proposal : bindVaultEdit(proposal, await prepareVaultSnapshot(dir), "cmo");
  const [row] = await state.sql`insert into noelle.agent_chat_messages(org_id,agent_instance_id,user_id,conversation_id,role,body,vault_edit)
    values(${org},${instanceId},${user},${conversationId},'agent','Review the proposal.',${state.sql.json(stored as never)}) returning id`;
  return { messageId: row!.id as string, stored };
}
const apply = (messageId: string, edit = proposal) => Reflect.apply(applyVaultEdit, undefined, [{ orgSlug: "fixture", instanceId, messageId, edit }]);

test.skipIf(!url)("chat persistence returns the actual agent message UUID while retaining user-first order", async () => {
  const stored = bindVaultEdit(proposal, await prepareVaultSnapshot(dir), "cmo");
  const id = await Reflect.apply(appendChatTurn, undefined, [{ instanceId, conversationId, userBody: "Please update the rules.", agentBody: "Review the proposal.", vaultEdit: stored, expectedOwner: { orgId: org, role: "cmo" } }]);
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  const rows = await state.sql`select id,role from noelle.agent_chat_messages order by seq`;
  expect(rows.map((row) => row.role)).toEqual(["user", "agent"]);
  expect(rows[1]?.id).toBe(id);
});
test.skipIf(!url)("history emits a public receipt without private hashes or file identity", async () => {
  const { messageId, stored } = await receipt();
  const history = await loadLatestChatConversation(instanceId);
  expect(history.messages[0]).toMatchObject({ vaultEdit: proposal, vaultEditReceipt: { messageId, eligible: true, refreshReason: null } });
  expect(JSON.stringify(history)).not.toContain(JSON.stringify(stored));
  expect(JSON.stringify(history)).not.toContain("rootIdentity");
  expect(JSON.stringify(history)).not.toContain("contentSha256");
});
test.skipIf(!url)("contradictory message organization never enters history or model context", async () => {
  await receipt();
  await state.sql`insert into noelle.agent_chat_messages(org_id,agent_instance_id,user_id,conversation_id,role,body) values(${foreign},${instanceId},${user},${conversationId},'agent','Foreign message must stay out.')`;
  expect((await loadLatestChatConversation(instanceId)).messages.map((message) => message.body)).not.toContain("Foreign message must stay out.");
  expect((await loadChatTurnsForModel(instanceId, conversationId)).map((message) => message.content)).not.toContain("Foreign message must stay out.");
});
test.skipIf(!url)("legacy rows require refresh rather than trusting a supplied client replacement", async () => {
  const { messageId } = await receipt(true);
  expect(await apply(messageId)).toEqual({ ok: false, error: "refresh_required" });
  expect(await readFile(join(dir, proposal.path), "utf8")).toBe("Original source.\r\n ");
  expect(state.revalidate).not.toHaveBeenCalled();
});
test.skipIf(!url)("the durable proposal remains authoritative when client content is forged", async () => {
  const { messageId } = await receipt();
  expect(await apply(messageId, { ...proposal, content: "Forged client replacement." })).toMatchObject({ ok: true, path: proposal.path });
  expect(await readFile(join(dir, proposal.path), "utf8")).toBe(proposal.content);
});
test.skipIf(!url)("an intervening save rejects the old captured source without overwriting", async () => {
  const { messageId } = await receipt();
  await writeFile(join(dir, proposal.path), "Newer saved rules.");
  expect(await apply(messageId)).toEqual({ ok: false, error: "conflict" });
  expect(await readFile(join(dir, proposal.path), "utf8")).toBe("Newer saved rules.");
  expect(state.revalidate).not.toHaveBeenCalled();
});
test.skipIf(!url)("a lost rename acknowledgment is uncertain and a repeat observes desired bytes without rewriting", async () => {
  const { messageId } = await receipt();
  state.lostRenameReceipt = true;
  expect(await apply(messageId)).toEqual({ ok: false, error: "uncertain" });
  expect(await readFile(join(dir, proposal.path), "utf8")).toBe(proposal.content);
  expect(state.revalidate).not.toHaveBeenCalled();
  state.lostRenameReceipt = false;
  expect(await apply(messageId)).toEqual({ ok: true, path: proposal.path });
});
test.skipIf(!url)("a current parent role change invalidates the stored proposal", async () => {
  const { messageId } = await receipt();
  await state.sql`update noelle.agent_instances set role='ceo' where id=${instanceId}`;
  expect(await apply(messageId)).toEqual({ ok: false, error: "refresh_required" });
  expect(await readFile(join(dir, proposal.path), "utf8")).toBe("Original source.\r\n ");
});
test.skipIf(!url)("a message owned by another user or organization cannot authorize a local write", async () => {
  const { messageId } = await receipt();
  await state.sql`update noelle.agent_chat_messages set user_id=gen_random_uuid() where id=${messageId}`;
  expect(await apply(messageId)).toEqual({ ok: false, error: "not_found" });
  await state.sql`update noelle.agent_chat_messages set user_id=${user},org_id=${foreign} where id=${messageId}`;
  expect(await apply(messageId)).toEqual({ ok: false, error: "not_found" });
  expect(await readFile(join(dir, proposal.path), "utf8")).toBe("Original source.\r\n ");
});
test.skipIf(!url)("a parent changed during generation cannot mint a persisted actionable message", async () => {
  const stored = bindVaultEdit(proposal, await prepareVaultSnapshot(dir), "cmo");
  await state.sql`update noelle.agent_instances set role='ceo' where id=${instanceId}`;
  await expect(appendChatTurn({ instanceId, conversationId, userBody: "Update rules", agentBody: "Review it", vaultEdit: stored, expectedOwner: { orgId: org, role: "cmo" } })).rejects.toThrow("owner changed");
  expect((await state.sql`select count(*)::int as n from noelle.agent_chat_messages`)[0]?.n).toBe(0);
});
test.skipIf(!url)("eight same-receipt actions with a parent pool of one retain one cooperative lifetime", async () => {
  const { messageId } = await receipt();
  const results = await Promise.all(Array.from({ length: 8 }, () => apply(messageId)));
  expect(results).toEqual(Array.from({ length: 8 }, () => ({ ok: true, path: proposal.path })));
  expect(await readFile(join(dir, proposal.path), "utf8")).toBe(proposal.content);
  expect((await state.sql`select 1 as healthy`)[0]?.healthy).toBe(1);
});
test.skipIf(!url)("a newly bound root cannot inherit the captured file authority", async () => {
  const { messageId } = await receipt();
  const alternate = await mkdtemp(join(tmpdir(), "vault-receipts-alternate-"));
  try {
    await writeFile(join(alternate, proposal.path), "Other bound root rules.");
    vi.stubEnv("NOELLE_VAULT_DIR", alternate);
    expect(await apply(messageId)).toEqual({ ok: false, error: "refresh_required" });
    expect(await readFile(join(alternate, proposal.path), "utf8")).toBe("Other bound root rules.");
    expect(await readFile(join(dir, proposal.path), "utf8")).toBe("Original source.\r\n ");
  } finally { vi.stubEnv("NOELLE_VAULT_DIR", dir); await rm(alternate, { recursive: true, force: true }); }
});

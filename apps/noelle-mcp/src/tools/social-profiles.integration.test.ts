import postgres from "postgres";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { NoelleContext } from "../context.js";
import { resolveAgentInstance } from "./_shared.js";
import { agentsModule } from "./agents.js";

const url = process.env.NOELLE_SOCIAL_BOOTSTRAP_TEST_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;
let orgId: string;
let ctx: NoelleContext;

beforeAll(async () => {
  if (!sql) return;
  const [database] = await sql`select current_database() as name`;
  if (database?.name !== "noelle_social_bootstrap_test") throw new Error("Dedicated social bootstrap test database required");
  const [org] = await sql`select id from noelle.organizations where slug='integration-workspace'`;
  if (!org) throw new Error("Run the CLI social bootstrap integration test first");
  orgId = org.id;
  ctx = {
    sql,
    resolveOrg: async () => ({ orgId, name: "Integration workspace", slug: "integration-workspace" }),
    assertWritable: vi.fn(),
  } as unknown as NoelleContext;
});

afterAll(async () => { await sql?.end({ timeout: 1 }); });

test.skipIf(!url)("selectors exclude archived coordinator profiles and retain supported social identities", async () => {
  const coordinators = await sql!`select id,role from noelle.agent_instances where role in ('ceo','cmo')`;
  expect(coordinators).toHaveLength(2);
  for (const coordinator of coordinators) {
    await expect(resolveAgentInstance(ctx, orgId, { role: coordinator.role })).rejects.toThrow("Unsupported social role");
    await expect(resolveAgentInstance(ctx, orgId, { agentInstanceId: coordinator.id })).rejects.toThrow("No agent instance");
  }
  expect(await resolveAgentInstance(ctx, orgId, { role: "x_intern" })).toMatchObject({ role: "x_intern" });
});

test.skipIf(!url)("bulk operations leave archived profiles and publication consent unchanged", async () => {
  const before = await sql!`select role,status,send_enabled,auto_send_enabled,reply_send_enabled from noelle.agent_instances order by role`;
  const result = await agentsModule.handle("noelle_start_all_agents", {}, ctx);
  expect(JSON.stringify(result)).toContain("Started **4** agent(s)");
  await agentsModule.handle("noelle_stop_all_agents", {}, ctx);
  const after = await sql!`select role,status,send_enabled,auto_send_enabled,reply_send_enabled from noelle.agent_instances order by role`;
  expect(after.filter((row) => row.role === 'ceo' || row.role === 'cmo')).toEqual(before.filter((row) => row.role === 'ceo' || row.role === 'cmo'));
  expect(after.every((row) => !row.send_enabled && !row.auto_send_enabled && !row.reply_send_enabled)).toBe(true);
  const list = await agentsModule.handle("noelle_list_agents", {}, ctx);
  expect(JSON.stringify(list)).not.toMatch(/ceo|cmo/);
});

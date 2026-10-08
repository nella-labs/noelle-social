import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { defaultConfig, findRepoRoot } from "../config.js";
import { applyMigrations, seedOperator } from "./migrate.js";

const url = process.env.NOELLE_SOCIAL_BOOTSTRAP_TEST_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;
const schemaDir = resolve(findRepoRoot(), "infra/cloudsql/schema");
const config = { ...defaultConfig(), orgSlug: "integration-workspace" };

beforeAll(async () => {
  if (!sql || !url) return;
  const [database] = await sql`select current_database() as name`;
  if (database?.name !== "noelle_social_bootstrap_test") throw new Error("Dedicated social bootstrap test database required");
  const [existing] = await sql`select to_regclass('noelle.agent_instances') as table_name`;
  if (existing?.table_name) throw new Error("A fresh social bootstrap test database is required");
  await applyMigrations({ adminUrl: url, schemaDir, log: () => {} });
  await seedOperator({ adminUrl: url, config, log: () => {} });
}, 60_000);

afterAll(async () => { await sql?.end({ timeout: 1 }); });

test.skipIf(!url)("fresh bootstrap contains only the configured operator and four paused social profiles", async () => {
  const orgs = await sql!`select slug from noelle.organizations`;
  expect(orgs.map((org) => org.slug)).toEqual([config.orgSlug]);
  const members = await sql!`select user_id::text as id from noelle.org_members`;
  expect(members.map((member) => member.id)).toEqual([config.operator.sub]);
  const emails = await sql!`select email from noelle.invited_emails`;
  expect(emails.map((row) => row.email)).toEqual([config.operator.email]);
  const profiles = await sql!`select role,status,send_enabled,auto_send_enabled,reply_send_enabled from noelle.agent_instances order by role`;
  expect(profiles.map((profile) => profile.role)).toEqual(["linkedin_intern", "reddit_intern", "video_intern", "x_intern"]);
  expect(profiles.every((profile) => profile.status === "paused" && !profile.send_enabled && !profile.auto_send_enabled && !profile.reply_send_enabled)).toBe(true);
  expect(await sql!`select id from noelle.vaults`).toHaveLength(0);
  await sql!`update noelle.agent_instances set status='active',display_name='Custom profile' where role='x_intern'`;
  await seedOperator({ adminUrl: url!, config, log: () => {} });
  const [x] = await sql!`select status,display_name from noelle.agent_instances where role='x_intern'`;
  expect(x).toMatchObject({ status: "active", display_name: "Custom profile" });
});

test.skipIf(!url)("retirement preserves coordinator IDs and conversation history without changing social profiles", async () => {
  const [org] = await sql!`select id from noelle.organizations where slug=${config.orgSlug}`;
  const ids = [randomUUID(), randomUUID()];
  for (const [index, role] of ["ceo", "cmo"].entries()) {
    await sql!`insert into noelle.agent_instances(id,org_id,role,status,send_enabled,auto_send_enabled,reply_send_enabled,goal_target,run_schedule_next_at)
      values(${ids[index]!},${org!.id},${role},'active',true,true,true,10,now())`;
    await sql!`insert into noelle.agent_chat_messages(org_id,agent_instance_id,user_id,conversation_id,role,body)
      values(${org!.id},${ids[index]!},${config.operator.sub},${randomUUID()},'user','Historical message')`;
  }
  const before = await sql!`select role,status,display_name from noelle.agent_instances where role='x_intern'`;
  const migration = readFileSync(resolve(schemaDir, "0127_retire_management_roles.sql"), "utf8");
  await sql!.unsafe(migration);
  await sql!.unsafe(migration);
  const coordinators = await sql!`select id::text,status,send_enabled,auto_send_enabled,reply_send_enabled,discovery_enabled,drafter_enabled,goal_target,run_schedule_next_at from noelle.agent_instances where role in ('ceo','cmo')`;
  expect(coordinators).toHaveLength(2);
  expect(coordinators.map((row) => row.id).sort()).toEqual(ids.sort());
  expect(coordinators.every((row) => row.status === 'retired' && !row.send_enabled && !row.auto_send_enabled && !row.reply_send_enabled && !row.discovery_enabled && !row.drafter_enabled && row.goal_target === null && row.run_schedule_next_at === null)).toBe(true);
  const chats = await sql!`select body from noelle.agent_chat_messages where agent_instance_id = any(${ids}::uuid[])`;
  expect(chats).toHaveLength(2);
  expect(await sql!`select role,status,display_name from noelle.agent_instances where role='x_intern'`).toEqual(before);
});

test.skipIf(!url)("fresh migrations reserve explicit replies for the dedicated request lane", async () => {
  const verifier = readFileSync(resolve(schemaDir, "../ops/verify-0101-operator-reply-claims.sql"), "utf8");
  await sql!.unsafe(verifier);
});

test.skipIf(!url)("forward migration repairs existing claim functions and is idempotent", async () => {
  const verifier = readFileSync(resolve(schemaDir, "../ops/verify-0101-operator-reply-claims.sql"), "utf8");
  await sql!.unsafe(readFileSync(resolve(schemaDir, "0114_safe_drafting_dates.sql"), "utf8"));
  try {
    await expect(sql!.unsafe(verifier)).rejects.toThrow("regular claim stole or missed rows");
  } finally {
    await sql!`rollback`;
  }
  const repair = readFileSync(resolve(schemaDir, "0128_restore_reply_request_claim_exclusions.sql"), "utf8");
  await sql!.unsafe(repair);
  await sql!.unsafe(repair);
  await sql!.unsafe(verifier);
});

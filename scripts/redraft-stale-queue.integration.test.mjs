import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

const run = promisify(execFile);
const target = "noelle_redraft_maintenance_test";
const script = fileURLToPath(new URL("./redraft-stale-queue.sql", import.meta.url));
const rawUrl = process.env.NOELLE_REDRAFT_MAINTENANCE_TEST_DATABASE_URL;
const enabled = Boolean(rawUrl);
let connection = [];
let password = "";
if (enabled) {
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new Error("Exact dedicated local database URL required"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !["localhost", "127.0.0.1"].includes(url.hostname)
      || url.pathname !== `/${target}` || !url.username || url.search || url.hash)
    throw new Error("Exact dedicated local database URL required");
  connection = ["-h", url.hostname, "-p", url.port || "5432", "-U", decodeURIComponent(url.username)];
  password = decodeURIComponent(url.password);
}
const cutoff = "2026-01-01 00:00:00+00";
const old = "2025-12-31 23:59:59+00";
const fresh = "2026-01-01 00:00:01+00";
const org = "00000000-0000-4000-8000-000000000001";
const ownX = "00000000-0000-4000-8000-000000000011";
const ownLi = "00000000-0000-4000-8000-000000000021";
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  PGAPPNAME: "manual_redraft_actual_psql_fixture",
  PGOPTIONS: "-c statement_timeout=5000 -c lock_timeout=1000",
  PGCONNECT_TIMEOUT: "3",
  PGPASSFILE: "/dev/null",
  PGPASSWORD: password,
};
let sequence = 100;
let admittedSourceSha;

function id() {
  return `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
}
function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
async function psql(database, args) {
  const argv = ["-X", ...connection, "-d", database, "-v", "ON_ERROR_STOP=1", ...args];
  return run("psql", argv, { env, timeout: 10000, maxBuffer: 1024 * 1024 });
}
async function query(text) {
  assert.equal((await psql(target, ["-qAt", "-c", "select current_database()"])).stdout.trim(), target);
  return (await psql(target, ["-qAt", "-c", text])).stdout.trim();
}
async function sourceSha() {
  return createHash("sha256").update(await readFile(script)).digest("hex");
}
async function lead(platform = "x") {
  const leadId = id();
  const instance = platform === "x" ? ownX : ownLi;
  await query(`insert into noelle.leads(id,external_id,org_id,agent_instance_id,platform,status,payload)
    values(${quote(leadId)},${quote(`fixture:${leadId}`)},${quote(org)},${quote(instance)},${quote(platform)},'drafted','{"text":"Native fixture source"}');`);
  return { leadId, instance };
}
async function draft(owner, { kind = "reply", at = old, status = "pending", edited = false } = {}) {
  const draftId = id();
  const approvalId = id();
  const payload = { kind, body: `Native fixture ${kind}`, ...(edited ? { edited_body: "Operator words", edited: true } : {}) };
  await query(`insert into noelle.drafts(id,lead_id,org_id,payload,synced_at)
    values(${quote(draftId)},${quote(owner.leadId)},${quote(org)},${quote(JSON.stringify(payload))}::jsonb,${quote(at)}::timestamptz);
    insert into noelle.approvals(id,org_id,agent_instance_id,draft_id,lead_id,status)
    values(${quote(approvalId)},${quote(org)},${quote(owner.instance)},${quote(draftId)},${quote(owner.leadId)},${quote(status)});`);
  return { draftId, approvalId };
}
async function actualScript() {
  assert.equal(await sourceSha(), admittedSourceSha);
  assert.equal((await psql(target, ["-qAt", "-c", "select current_database()"])).stdout.trim(), target);
  await psql(target, ["-v", "platform=x", "-v", `cutoff=${cutoff}`, "-f", script]);
  const state = JSON.parse(await query(`select coalesce(jsonb_agg(jsonb_build_object(
    'approval_id',a.id,'status',a.status,'skip_reason',a.skip_reason,'kind',d.payload->>'kind',
    'synced_at',d.synced_at,'lead_status',l.status) order by a.id),'[]'::jsonb)
    from noelle.approvals a join noelle.drafts d on d.id=a.draft_id
    join noelle.leads l on l.id=a.lead_id;`));
  return state;
}
function row(state, item) {
  const found = state.find(value => value.approval_id === item.approvalId);
  assert.ok(found, "actual persisted approval exists");
  return found;
}

before(async () => {
  if (!enabled) return;
  admittedSourceSha = await sourceSha();
  assert.equal((await psql(target, ["-qAt", "-c", "select current_database()"])).stdout.trim(), target,
    "current_database exact before any schema DDL");
  await query("drop schema if exists noelle cascade");
  for (const name of ["0001_noelle_schema.sql", "0005_leads_full_schema.sql"])
    await psql(target, ["-q", "-f", fileURLToPath(new URL(`../infra/cloudsql/schema/${name}`, import.meta.url))]);
});
beforeEach(async () => {
  if (!enabled) return;
  sequence = 100;
  await query(`truncate noelle.organizations cascade;
    insert into noelle.organizations(id,slug,name) values(${quote(org)},'redraft-fixture','Redraft fixture');
    insert into noelle.agent_instances(id,org_id,role,status) values
      (${quote(ownX)},${quote(org)},'x_intern','active'),(${quote(ownLi)},${quote(org)},'linkedin_intern','active');`);
});
after(async () => {
  if (!enabled) return;
  assert.equal(await sourceSha(), admittedSourceSha, "script unchanged during native proof");
  const sessions = (await psql("postgres", ["-qAt", "-c",
    `select count(*) from pg_stat_activity where datname=${quote(target)}`])).stdout.trim();
  assert.equal(sessions, "0", "all psql children awaited; independent observer sees no target sessions");
});


test("actual script preserves a pending companion DM when an old reply qualifies", { skip: !enabled }, async () => {
  const owner = await lead();
  const reply = await draft(owner);
  const dm = await draft(owner, { kind: "dm" });
  const state = await actualScript();
  assert.equal(row(state, reply).status, "skipped");
  assert.equal(row(state, dm).status, "pending", "documented reply-only retirement must preserve companion DM");
});
test("actual script preserves an after-cutoff reply on an eligible lead", { skip: !enabled }, async () => {
  const owner = await lead();
  const oldReply = await draft(owner);
  const freshReply = await draft(owner, { at: fresh });
  const state = await actualScript();
  assert.equal(row(state, oldReply).status, "skipped");
  assert.equal(row(state, freshReply).status, "pending", "documented cutoff must preserve newly drafted reply");
});
test("healthy old pending reply is retired and its lead requeued", { skip: !enabled }, async () => {
  const reply = await draft(await lead());
  const state = await actualScript();
  assert.equal(row(state, reply).status, "skipped");
  assert.equal(row(state, reply).lead_status, "classified");
});
test("healthy DM-only lead is untouched", { skip: !enabled }, async () => {
  const dm = await draft(await lead(), { kind: "dm" });
  const state = await actualScript();
  assert.equal(row(state, dm).status, "pending");
  assert.equal(row(state, dm).lead_status, "drafted");
});
test("healthy all-after-cutoff lead is untouched", { skip: !enabled }, async () => {
  const reply = await draft(await lead(), { at: fresh });
  const state = await actualScript();
  assert.equal(row(state, reply).status, "pending");
  assert.equal(row(state, reply).lead_status, "drafted");
});
test("healthy sent and skipped approvals keep their terminal statuses", { skip: !enabled }, async () => {
  const owner = await lead();
  const reply = await draft(owner);
  const sent = await draft(owner, { status: "sent" });
  const skipped = await draft(owner, { status: "skipped" });
  const state = await actualScript();
  assert.equal(row(state, reply).status, "skipped");
  assert.equal(row(state, sent).status, "sent");
  assert.equal(row(state, skipped).status, "skipped");
});
test("healthy current edited=true body protects its whole lead", { skip: !enabled }, async () => {
  const owner = await lead();
  const reply = await draft(owner, { edited: true });
  const dm = await draft(owner, { kind: "dm" });
  const state = await actualScript();
  assert.equal(row(state, reply).status, "pending");
  assert.equal(row(state, dm).status, "pending");
  assert.equal(row(state, reply).lead_status, "drafted");
});
test("healthy other platform is untouched while requested X lane is retired", { skip: !enabled }, async () => {
  const x = await draft(await lead());
  const li = await draft(await lead("linkedin"));
  const state = await actualScript();
  assert.equal(row(state, x).status, "skipped");
  assert.equal(row(state, li).status, "pending");
  assert.equal(row(state, li).lead_status, "drafted");
});

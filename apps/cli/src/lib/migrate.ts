import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { CONCURRENT_INDEX_MIGRATIONS, transactionalMigrationBody } from "./migration-policy.js";
import type { SelfHostConfig } from "../config.js";

/**
 * Apply the infra/cloudsql schema to a local Postgres, record a migration
 * ledger (noelle.schema_migrations, read by the System page), and seed the
 * single operator + org. Transactional DDL and its ledger receipt commit together.
 * Explicit concurrent-index migrations recover through their native validity.
 *
 * Two things diverge from a naive `psql -f *.sql`:
 *   1. 0003_grant_vercel_wif_user.sql is SKIPPED — it only sets up Vercel's
 *      Workload Identity role, which doesn't exist locally.
 *   2. A stub `vercel-noelle-app@noelle-agents.iam` role is created first, so
 *      the incidental grants in 0005/0016 succeed harmlessly instead of
 *      aborting the run.
 */

/** Migration files to skip entirely (GCP/Vercel-only). */
export const SKIP_MIGRATIONS = new Set(["0003_grant_vercel_wif_user.sql"]);

/** The Cloud SQL IAM role the schema grants to; stubbed locally so grants pass. */
const STUB_IAM_ROLE = "vercel-noelle-app@noelle-agents.iam";

/**
 * Ordering constraints [earlier, later] that lexicographic sort gets wrong.
 * 0003_x_watchlist.sql indexes drafts(sent_at), but that column is added by
 * 0004_drafts_sent_at.sql — so 0004 must run first (the runbook caveat).
 */
const ORDER_BEFORE: Array<[string, string]> = [
  ["0004_drafts_sent_at.sql", "0003_x_watchlist.sql"],
];

/** Apply [earlier, later] constraints to a list by moving `earlier` ahead. */
function enforceOrder(files: string[]): string[] {
  const out = [...files];
  for (const [earlier, later] of ORDER_BEFORE) {
    const ei = out.indexOf(earlier);
    const li = out.indexOf(later);
    if (ei === -1 || li === -1 || ei < li) continue;
    out.splice(ei, 1);
    out.splice(out.indexOf(later), 0, earlier);
  }
  return out;
}

/** Ordered list of migration files to apply (lexicographic + skips + caveats). */
export function listMigrations(schemaDir: string): string[] {
  const sorted = readdirSync(schemaDir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => !SKIP_MIGRATIONS.has(f))
    .sort();
  return enforceOrder(sorted);
}

export async function applyMigrations(args: {
  adminUrl: string;
  schemaDir: string;
  log: (msg: string) => void;
}): Promise<string[]> {
  const { adminUrl, schemaDir, log } = args;
  const files = listMigrations(schemaDir);
  const pool = postgres(adminUrl, { max: 1, ssl: false, connect_timeout: 5, connection: { application_name: "noelle-cli-migrations" }, onnotice: () => {} });
  const applied: string[] = [];
  try {
    const sql = await pool.reserve();
    await sql.unsafe("set lock_timeout = '5s'; set statement_timeout = '20min'");
    // The dedicated connection retains this database-local session lock until
    // its owned pool closes, including between concurrent-index statements.
    await sql`select pg_advisory_lock(721468321, 0)`;
    // Prereqs the migration files assume on a managed box.
    await sql.unsafe(`create schema if not exists noelle`);
    await sql.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${STUB_IAM_ROLE}') then
          create role "${STUB_IAM_ROLE}";
        end if;
      end $$;
    `);
    await sql.unsafe(`
      create table if not exists noelle.schema_migrations (
        filename   text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    // Ledger-based skip: only apply migrations we haven't recorded. Not every
    // schema file is individually re-runnable (e.g. 0001 uses bare
    // `create table`), so the ledger — not per-file idempotency — is what makes
    // `migrate` / `up` safe to re-run.
    const done = new Set(
      (await sql<Array<{ filename: string }>>`select filename from noelle.schema_migrations`).map(
        (r) => r.filename,
      ),
    );

    for (const file of files) {
      if (done.has(file)) {
        log(`Skipping ${file} (already applied)`);
        continue;
      }
      const body = readFileSync(resolve(schemaDir, file), "utf8");
      log(`Applying ${file}…`);
      const index = CONCURRENT_INDEX_MIGRATIONS[file];
      if (index) {
        const state = await sql<{ valid: boolean; ready: boolean; unique: boolean; owned_table: boolean; columns: (string | null)[] }[]>`
          select i.indisvalid as valid, i.indisready as ready, i.indisunique as unique,
            i.indrelid=to_regclass('noelle.leads') as owned_table,
            array(select a.attname::text from unnest(i.indkey) with ordinality k(attnum, position)
              left join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum order by k.position) as columns
          from pg_index i where i.indexrelid=to_regclass(${'noelle.' + index.index})
        `;
        const existing = state[0];
        if (existing && (!existing.owned_table || existing.unique !== index.unique ||
            JSON.stringify(existing.columns) !== JSON.stringify(index.columns)))
          throw new Error(`Concurrent migration index shape differs: ${file}`);
        if (existing && (!existing.valid || !existing.ready))
          await sql.unsafe(`drop index concurrently if exists noelle.${index.index}`);
        await sql.unsafe(body);
        const [built] = await sql<{ valid: boolean; ready: boolean }[]>`
          select indisvalid as valid, indisready as ready from pg_index
          where indexrelid=to_regclass(${'noelle.' + index.index})
        `;
        if (!built?.valid || !built.ready) throw new Error(`Concurrent migration index is not valid: ${file}`);
        await sql`insert into noelle.schema_migrations(filename) values (${file})`;
      } else {
        const transactionalBody = transactionalMigrationBody(file, body);
        await sql.unsafe("begin");
        try {
          await sql.unsafe(transactionalBody);
          await sql`insert into noelle.schema_migrations(filename) values (${file})`;
          await sql.unsafe("commit");
        } catch (error) {
          // A lost connection closes the owned session and rolls back its TX.
          // Only a healthy server SQL error needs an explicit rollback here.
          if ((error as { severity?: unknown }).severity === "ERROR" &&
              !String((error as { code?: unknown }).code).startsWith("08"))
            await sql.unsafe("rollback").catch(() => {});
          throw error;
        }
      }
      applied.push(file);
    }

    // schema_migrations is created before 0001's `alter default privileges`,
    // so it misses the auto-grant to noelle_app. Grant read explicitly so the
    // System page (which queries as noelle_app) can show the ledger.
    await sql.unsafe(`
      do $$ begin
        if exists (select 1 from pg_roles where rolname = 'noelle_app') then
          grant select on noelle.schema_migrations to noelle_app;
        end if;
      end $$;
    `);
  } finally {
    await pool.end({ timeout: 1 }).catch(() => {});
  }
  return applied;
}

/**
 * Seed the single operator: org, owner membership, allowlist row, and the
 * social profiles. Repeated setup preserves existing profile state.
 */
export async function seedOperator(args: {
  adminUrl: string;
  config: SelfHostConfig;
  log: (msg: string) => void;
}): Promise<void> {
  const { adminUrl, config, log } = args;
  const { operator, orgSlug } = config;
  const sql = postgres(adminUrl, { max: 1, ssl: false, onnotice: () => {} });
  try {
    log(`Seeding operator ${operator.email} → org "${orgSlug}"…`);
    await sql`
      insert into noelle.organizations (slug, name, plan)
      values (${orgSlug}, ${operator.name + "'s Workspace"}, 'alpha')
      on conflict (slug) do nothing
    `;
    await sql`
      insert into noelle.org_members (org_id, user_id, role)
      select id, ${operator.sub}::uuid, 'owner'
      from noelle.organizations where slug = ${orgSlug}
      on conflict (org_id, user_id) do update set role = excluded.role
    `;
    await sql`
      insert into noelle.invited_emails (email, is_admin)
      values (lower(${operator.email}), true)
      on conflict (email) do update set is_admin = true
    `;
    await sql`
      insert into noelle.agent_instances
        (org_id, role, status, display_name, budget_cap_cents,
         discovery_enabled, classifier_enabled, drafter_enabled,
         send_enabled, auto_send_enabled, reply_send_enabled)
      select o.id, r.role, 'paused', r.display_name, ${config.budgetCapCents},
             false, true, false, false, false, false
      from noelle.organizations o,
        (values ('x_intern','Vega'),('linkedin_intern','Lyra'),
                ('reddit_intern','Orion'),('video_intern','Nova'))
          as r(role, display_name)
      where o.slug = ${orgSlug}
      on conflict (org_id, role) do nothing
    `;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

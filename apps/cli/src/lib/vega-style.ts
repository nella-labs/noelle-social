import postgres from "postgres";
import type { Sql, TransactionSql } from "postgres";
import { AccountFeederConfigSchema, type AccountFeederConfig } from "@noelle/contracts";

// `noelle vega style` — manage Vega's Account Feeder: the operator picks the X
// account(s) whose FORM (rhythm, hooks, sentence shape) becomes the voice of
// Vega's posts. Sources live in noelle.account_feeder_sources (platform='x'); the
// pin + selection knobs live in agent_instances.account_feeder_config (jsonb); a
// pull is triggered by stamping account_feeder_run_requested_at (the feeder worker
// polls it). All scoped to the org's single x_intern (Vega) instance.
//
// CONTENT still comes from the operator's own vault — the feeder only shapes FORM.

function conn(dbUrl: string): Sql {
  return postgres(dbUrl, { max: 1, ssl: false, onnotice: () => {} });
}

function normHandle(h: string): string {
  return h.trim().toLowerCase().replace(/^@/, "");
}

function updateStyleConfig(current: unknown, update: (config: AccountFeederConfig) => void): Partial<AccountFeederConfig> {
  const raw = current && typeof current === "object"
    ? current as Record<string, unknown>
    : {};
  const parsed = AccountFeederConfigSchema.parse(raw);
  update(parsed);
  const next: Partial<AccountFeederConfig> = parsed;
  if (!Object.hasOwn(raw, "styleExemplarKinds")) delete next.styleExemplarKinds;
  return next;
}

export function pinnedVegaStyleConfig(current: unknown, handle: string): Partial<AccountFeederConfig> {
  return updateStyleConfig(current, config => {
    config.pinnedStyleHandle = normHandle(handle);
    config.maxStyleExemplars = Math.max(config.maxStyleExemplars, 6);
    config.varietyTemperature = 0;
  });
}

// Resolve the org's x_intern (Vega) instance id + org_id, or null when absent.
async function xInstance(sql: Sql | TransactionSql, orgSlug: string): Promise<{ id: string; org_id: string } | null> {
  const rows = await sql<Array<{ id: string; org_id: string }>>`
    select ai.id, ai.org_id
    from noelle.agent_instances ai
    join noelle.organizations o on o.id = ai.org_id
    where o.slug = ${orgSlug} and ai.role = 'x_intern'
    limit 1
  `;
  return rows[0] ?? null;
}

export async function vegaStyleAddSource(args: {
  dbUrl: string;
  orgSlug: string;
  handle: string;
  displayName?: string | null;
  note?: string | null;
}): Promise<{ found: boolean }> {
  const sql = conn(args.dbUrl);
  try {
    const inst = await xInstance(sql, args.orgSlug);
    if (!inst) return { found: false };
    const handle = normHandle(args.handle);
    await sql`
      insert into noelle.account_feeder_sources
        (org_id, agent_instance_id, platform, handle, display_name, note, enabled)
      values (${inst.org_id}, ${inst.id}, 'x', ${handle}, ${args.displayName ?? null}, ${args.note ?? null}, true)
      on conflict (agent_instance_id, platform, handle) do update
        set enabled = true,
            display_name = coalesce(excluded.display_name, noelle.account_feeder_sources.display_name),
            note = coalesce(excluded.note, noelle.account_feeder_sources.note)
    `;
    return { found: true };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

export async function vegaStyleRemoveSource(args: {
  dbUrl: string;
  orgSlug: string;
  handle: string;
}): Promise<{ found: boolean; removed: boolean }> {
  const sql = conn(args.dbUrl);
  try {
    const inst = await xInstance(sql, args.orgSlug);
    if (!inst) return { found: false, removed: false };
    const rows = await sql`
      update noelle.account_feeder_sources
      set enabled = false
      where agent_instance_id = ${inst.id} and platform = 'x' and handle = ${normHandle(args.handle)}
      returning id
    `;
    return { found: true, removed: rows.length > 0 };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

export async function vegaStylePin(args: {
  dbUrl: string;
  orgSlug: string;
  handle: string;
}): Promise<{ found: boolean }> {
  // Pin the named voice + make it actually land: floor the exemplars (>=6),
  // drop variety to 0, and preserve a corpus kind only when the operator had
  // explicitly stored one. Otherwise X faithful replies choose comments.
  return persistStyleConfig(args, current => pinnedVegaStyleConfig(current, args.handle));
}

async function persistStyleConfig(
  args: { dbUrl: string; orgSlug: string },
  update: (current: unknown) => Partial<AccountFeederConfig> | null,
): Promise<{ found: boolean }> {
  const sql = conn(args.dbUrl);
  try {
    return await sql.begin(async tx => {
      await tx`
        select set_config('lock_timeout', '2000', true),
          set_config('statement_timeout', '5000', true),
          set_config('idle_in_transaction_session_timeout', '5000', true)
      `;
      const inst = await xInstance(tx, args.orgSlug);
      if (!inst) return { found: false };
      const rows = await tx<Array<{ account_feeder_config: unknown }>>`
        select account_feeder_config from noelle.agent_instances where id = ${inst.id} for update
      `;
      const next = update(rows[0]?.account_feeder_config);
      if (next !== null) {
        await tx`
          update noelle.agent_instances
          set account_feeder_config = ${tx.json(next)}
          where id = ${inst.id}
        `;
      }
      return { found: true };
    });
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

export async function vegaStyleUnpin(args: {
  dbUrl: string;
  orgSlug: string;
}): Promise<{ found: boolean }> {
  return persistStyleConfig(args, current => {
    if (!current || typeof current !== "object") return null;
    return updateStyleConfig(current, config => { delete config.pinnedStyleHandle; });
  });
}

export async function vegaStyleRun(args: {
  dbUrl: string;
  orgSlug: string;
}): Promise<{ found: boolean }> {
  const sql = conn(args.dbUrl);
  try {
    const inst = await xInstance(sql, args.orgSlug);
    if (!inst) return { found: false };
    await sql`
      update noelle.agent_instances
      set account_feeder_run_requested_at = now()
      where id = ${inst.id}
    `;
    return { found: true };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

export interface VegaStyleOverview {
  found: boolean;
  pinnedStyleHandle: string | null;
  lastRunAt: string | null;
  stylePostCount: number;
  ultraProfileCount: number;
  sources: Array<{
    handle: string;
    displayName: string | null;
    enabled: boolean;
    lastPulledAt: string | null;
  }>;
}

export async function vegaStyleList(args: {
  dbUrl: string;
  orgSlug: string;
}): Promise<VegaStyleOverview> {
  const sql = conn(args.dbUrl);
  const empty: VegaStyleOverview = {
    found: false,
    pinnedStyleHandle: null,
    lastRunAt: null,
    stylePostCount: 0,
    ultraProfileCount: 0,
    sources: [],
  };
  try {

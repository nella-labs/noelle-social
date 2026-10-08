import postgres from "postgres";

/**
 * Vega (X-intern) lifecycle on self-host. Enabling Vega stamps the per-instance
 * spend cap (budget_cap_cents) so the worker pool can never spend past it —
 * callAgentModel runs the three-layer cap pre-check (budgetBucket) before every
 * LLM call and throws BudgetExceededError if this call would push month-to-date
 * spend past the cap. send_enabled + auto_send_enabled are forced OFF in the
 * discover→draft→queue phase so nothing is ever posted to X.
 *
 * The cap is stamped UNCONDITIONALLY only when the operator asked for a cap in
 * this invocation (`noelle vega enable [--budget-cents N]`). The automatic
 * bring-up path (`noelle up`, which `noelle sync` also runs on self-heal and on
 * every login) passes preserveExistingCap so it can only ever SEED a missing
 * cap, never lower one the operator raised. Without that, a cap raised in the
 * dashboard silently reverted to config.json's default within ~10 minutes —
 * every self-heal tick re-stamped it, so the operator's change never survived.
 * That same automatic path also preserves the agent status and every worker
 * switch, so bringing the local processes back does not undo Stop all.
 */

export interface VegaState {
  found: boolean;
  status: string;
  budgetCapCents: number | null;
  flags: {
    discovery: boolean;
    classifier: boolean;
    drafter: boolean;
    send: boolean;
    autoSend: boolean;
  };
}

export async function vegaEnable(args: {
  dbUrl: string;
  orgSlug: string;
  budgetCapCents: number;
  /**
   * When true, budget_cap_cents is only SEEDED (set when NULL) instead of
   * overwritten. The automatic bring-up path sets this so a cap the operator
   * raised is never silently stamped back down to the config.json default.
   */
  preserveExistingCap?: boolean;
  /** Keep the operator's current agent status and lane/send switches intact. */
  preservePipelineState?: boolean;
  log: (m: string) => void;
}): Promise<VegaState> {
  const sql = postgres(args.dbUrl, { max: 1, ssl: false, onnotice: () => {} });
  try {
    const rows = await sql<
      Array<{
        status: string;
        budget_cap_cents: number | null;
        discovery_enabled: boolean;
        classifier_enabled: boolean;
        drafter_enabled: boolean;
        send_enabled: boolean;
        auto_send_enabled: boolean;
      }>
    >`
      update noelle.agent_instances ai
      set -- Bound booleans drive SQL cases, NOT conditional JS fragments:
          -- postgres.js throws when a tagged fragment is chosen mid-statement.
          budget_cap_cents = case
            when ${args.preserveExistingCap ?? false}
              then coalesce(ai.budget_cap_cents, ${args.budgetCapCents})
            else ${args.budgetCapCents}
          end,
          status = case when ${args.preservePipelineState ?? false} then ai.status else 'active' end,
          discovery_enabled = case when ${args.preservePipelineState ?? false} then ai.discovery_enabled else true end,
          classifier_enabled = case when ${args.preservePipelineState ?? false} then ai.classifier_enabled else true end,
          drafter_enabled = case when ${args.preservePipelineState ?? false} then ai.drafter_enabled else true end,
          send_enabled = case when ${args.preservePipelineState ?? false} then ai.send_enabled else false end,
          auto_send_enabled = case when ${args.preservePipelineState ?? false} then ai.auto_send_enabled else false end
      from noelle.organizations o
      where ai.org_id = o.id and o.slug = ${args.orgSlug} and ai.role = 'x_intern'
      returning ai.status, ai.budget_cap_cents, ai.discovery_enabled,
                ai.classifier_enabled, ai.drafter_enabled, ai.send_enabled,
                ai.auto_send_enabled
    `;
    const r = rows[0];
    if (!r) {
      args.log(`No x_intern instance found for org "${args.orgSlug}" — run migrate/seed first.`);
      return emptyState();
    }
    // Log the cap the row ACTUALLY carries, not the one we asked for — under
    // preserveExistingCap they differ, and printing the request would report a
    // reset that did not happen.
    const effectiveCap = r.budget_cap_cents == null ? null : Number(r.budget_cap_cents);
    const onOff = (enabled: boolean) => enabled ? "on" : "off";
    args.log(`Vega ${r.status} · discovery ${onOff(r.discovery_enabled)} · classifier ${onOff(r.classifier_enabled)} · drafter ${onOff(r.drafter_enabled)} · send ${onOff(r.send_enabled)} · auto-send ${onOff(r.auto_send_enabled)} · cap ${
      effectiveCap == null ? "none" : `$${(effectiveCap / 100).toFixed(2)}`
    }`);
    return toState(r);
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

export async function vegaDisable(args: { dbUrl: string; orgSlug: string }): Promise<void> {
  const sql = postgres(args.dbUrl, { max: 1, ssl: false, onnotice: () => {} });
  try {
    await sql`
      update noelle.agent_instances ai
      set status = 'paused'
      from noelle.organizations o
      where ai.org_id = o.id and o.slug = ${args.orgSlug} and ai.role = 'x_intern'
    `;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

export async function vegaState(args: { dbUrl: string; orgSlug: string }): Promise<VegaState> {
  const sql = postgres(args.dbUrl, { max: 1, ssl: false, onnotice: () => {} });
  try {
    const rows = await sql<
      Array<{
        status: string;
        budget_cap_cents: number | null;
        discovery_enabled: boolean;
        classifier_enabled: boolean;
        drafter_enabled: boolean;
        send_enabled: boolean;
        auto_send_enabled: boolean;
      }>
    >`
      select ai.status, ai.budget_cap_cents, ai.discovery_enabled,
             ai.classifier_enabled, ai.drafter_enabled, ai.send_enabled,
             ai.auto_send_enabled
      from noelle.agent_instances ai
      join noelle.organizations o on o.id = ai.org_id
      where o.slug = ${args.orgSlug} and ai.role = 'x_intern'
      limit 1
    `;
    const r = rows[0];
    return r ? toState(r) : emptyState();
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

function toState(r: {
  status: string;
  budget_cap_cents: number | null;
  discovery_enabled: boolean;
  classifier_enabled: boolean;
  drafter_enabled: boolean;
  send_enabled: boolean;
  auto_send_enabled: boolean;
}): VegaState {
  return {
    found: true,
    status: r.status,
    // budget_cap_cents is an integer column; coerce defensively.
    budgetCapCents: r.budget_cap_cents == null ? null : Number(r.budget_cap_cents),
    flags: {
      discovery: r.discovery_enabled,
      classifier: r.classifier_enabled,
      drafter: r.drafter_enabled,
      send: r.send_enabled,
      autoSend: r.auto_send_enabled,
    },
  };
}

function emptyState(): VegaState {
  return {
    found: false,
    status: "absent",
    budgetCapCents: null,
    flags: { discovery: false, classifier: false, drafter: false, send: false, autoSend: false },
  };
}

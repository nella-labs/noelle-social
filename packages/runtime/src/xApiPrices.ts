import type { SpendRow } from "./spendRecorder.js";

/**
 * Build a noelle.llm_calls SpendRow for one official X API WRITE (a post or a
 * reply). The X API bills a FLAT MONTHLY tier, not per-call, so the per-write
 * cents are 0 — the subscription cost is metered separately on the Spends page.
 * These rows exist for VISIBILITY (daily write counts) and, like 'apify', are
 * EXEMPT from budget caps — but only for the X intern, the one app that writes
 * these rows: it is the sole caller that passes CAP_EXEMPT_ENGINES_APIFY_XAPI to
 * createPgBudgetAdapters (./pgBudgetAdapters.ts). Its siblings exempt apify only.
 */
export function xApiActionRow(args: {
  orgId: string;
  instanceId: string | null;
  /** The worker that wrote: "send" (replies) | "content-publish" (posts). */
  worker: string;
  kind: "post" | "reply";
  startedAt: Date;
  latencyMs?: number | null;
}): SpendRow {
  return {
    orgId: args.orgId,
    instanceId: args.instanceId,
    agentRole: "x_intern",
    worker: args.worker,
    engine: "xapi",
    model: "xapi",
    bucket: `xapi-${args.kind}`,
    inputTokens: 0,
    outputTokens: 0,
    cents: 0,
    latencyMs: args.latencyMs ?? null,
    status: "ok",
    startedAt: args.startedAt,
    credentialId: null,
  };
}

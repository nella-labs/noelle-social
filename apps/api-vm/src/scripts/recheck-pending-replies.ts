import type { LlmBackendQuery } from "@noelle/runtime";
import { importAfterOperatorEnv } from "./recheck-env.js";

function options(argv: string[]): { orgId: string; maxReviews: number } {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("usage: recheck-pending-replies --org-id <uuid> [--max-reviews <1..1000>]");
    }
    values.set(name, value);
  }
  for (const key of values.keys()) {
    if (key !== "--org-id" && key !== "--max-reviews") throw new Error(`unknown option: ${key}`);
  }
  const orgId = values.get("--org-id");
  if (!orgId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    throw new Error("--org-id must be a UUID");
  }
  const rawMax = values.get("--max-reviews") ?? "100";
  const maxReviews = Number(rawMax);
  if (!Number.isInteger(maxReviews) || maxReviews < 1 || maxReviews > 1_000) {
    throw new Error("--max-reviews must be an integer from 1 to 1000");
  }
  return { orgId, maxReviews };
}

async function main() {
  const { orgId, maxReviews } = options(process.argv.slice(2));
  // Runtime modules can snapshot model flags at import time. Load the local
  // operator env first; explicit shell/PM2 values retain precedence.
  const [postgresModule, runtime, budgetAdapters, spendRecorder, secrets, recheck, store] =
    await importAfterOperatorEnv(() => Promise.all([
      import("postgres"),
      import("@noelle/runtime"),
      import("@noelle/runtime/pg-budget-adapters"),
      import("@noelle/runtime/pg-spend-recorder"),
      import("@noelle/secrets"),
      import("../lib/pending-reply-recheck.js"),
      import("../lib/pending-reply-recheck-store.js"),
    ]));
  const { default: postgres } = postgresModule;
  const { buildEngineRegistry, makeLlmBackendResolver } = runtime;
  const { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY, CAP_EXEMPT_ENGINES_APIFY_XAPI } = budgetAdapters;
  const { createPgSpendRecorder } = spendRecorder;
  const { createSecretsClient } = secrets;
  const { createConfiguredPendingReplyReviewer, recheckPendingReplies } = recheck;
  const { postgresPendingReplyStore } = store;
  const databaseUrl = process.env.NOELLE_DATABASE_URL;
  if (!databaseUrl) throw new Error("NOELLE_DATABASE_URL is required");
  if (!process.env.TYPESAFE_API_KEY && !process.env.AI_GATEWAY_API_KEY) {
    throw new Error("TYPESAFE_API_KEY or AI_GATEWAY_API_KEY is required");
  }
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 30 });
  try {
    const engines = await buildEngineRegistry({
      secrets: createSecretsClient({ project: process.env.GCP_PROJECT ?? "noelle-agents" }),
    });
    const common = {
      engines,
      recorder: createPgSpendRecorder(sql),
      getLlmBackend: makeLlmBackendResolver(sql as unknown as LlmBackendQuery),
    };
    const budgets = {
      linkedin: { adapters: createPgBudgetAdapters(sql, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY }) },
      x: { adapters: createPgBudgetAdapters(sql, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY_XAPI }) },
    };
    const counts = await recheckPendingReplies({
      orgId,
      maxReviews,
      store: postgresPendingReplyStore(sql),
      review: createConfiguredPendingReplyReviewer({
        depsForPlatform: (platform) => ({ ...common, budget: budgets[platform] }),
      }),
    });
    console.log(JSON.stringify({ orgId, ...counts }));
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

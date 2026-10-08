import { importAfterOperatorEnv } from "./recheck-env.js";
import { parseReconcileOptions, resolveXReplyMaxAgeHours } from "./reconcile-options.js";

async function main(): Promise<void> {
  const options = parseReconcileOptions(process.argv.slice(2));
  const [postgresModule, runtime, policyModule, reconcileModule, storeModule] =
    await importAfterOperatorEnv(() => Promise.all([
      import("postgres"),
      import("@noelle/runtime"),
      import("../routes/linkedin-voice-policy.js"),
      import("../lib/pending-reply-reconcile.js"),
      import("../lib/pending-reply-reconcile-store.js"),
    ]));
  const databaseUrl = process.env.NOELLE_DATABASE_URL;
  if (!databaseUrl) throw new Error("NOELLE_DATABASE_URL is required");
  const sql = postgresModule.default(databaseUrl, { max: 1, idle_timeout: 30 });
  try {
    const now = new Date();
    const counts = await reconcileModule.reconcilePendingReplyBacklog({
      orgId: options.orgId,
      store: storeModule.postgresPendingReplyReconcileStore(sql),
      apply: options.apply,
      policy: {
        linkedinVoiceFloor: policyModule.resolveLinkedInVoiceFloor(),
        xMaxAgeHours: resolveXReplyMaxAgeHours(process.env.X_REPLY_MAX_AGE_HOURS),
        notificationMaxAgeHours: runtime.NOTIFICATION_MAX_AGE_HOURS,
        now,
      },
    });
    console.log(JSON.stringify({
      orgId: options.orgId,
      mode: options.apply ? "apply" : "dry-run",
      decidedAt: now.toISOString(),
      ...counts,
    }));
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

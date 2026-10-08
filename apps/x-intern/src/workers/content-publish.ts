import { loadEnv } from "../env.js";
import { createLogger, type Logger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listSendXInternInstances, isWorkerEnabled } from "../lib/activation.js";
import { runBootChecks } from "../lib/boot.js";
import { createNotifier, createAlertOnce } from "@noelle/runtime/notifier";
import { createSecretsClient } from "../lib/secrets.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { type XWriteClient } from "@noelle/x-client";
import { readXApiTokens } from "../lib/x-api-tokens.js";
import { buildXApiClient } from "../lib/x-api-client-factory.js";
import { runContentPublishTick } from "./content-publish-tick.js";
import { runContentMetricsTick } from "./content-metrics-tick.js";
import { resolveContentMedia } from "@noelle/runtime/content-push";
import type { Sql } from "postgres";
import { haltXSend } from "../lib/send-halt-db.js";

// content-publish: Vega-only. Publishes scheduled, auto-publish content slots via
// the OFFICIAL X API (never bird — bird can only reply). Shares send_enabled with
// the reply send worker, so an account lock halts BOTH.
//
// It also hosts the content-metrics sweep: a throttled read (GET /2/tweets) that
// re-measures the operator's own published posts for the Performance tab. It
// reuses the write-token client built here (a read costs no write budget).

// Client construction now lives in lib/x-api-client-factory.ts so the ideation
// worker's own-account sweep reuses it instead of copying it. Behaviour here is
// unchanged: no tokens → null, else oauth1a when fully specified, else oauth2.
async function buildClient(
  sql: Sql,
  env: ReturnType<typeof loadEnv>,
  instanceId: string,
  handleFallback: string | null,
  log: Logger,
): Promise<XWriteClient | null> {
  const tokens = await readXApiTokens(sql, instanceId);
  if (!tokens) return null;
  return buildXApiClient({
    sql,
    instanceId,
    tokens,
    envClientId: env.X_API_CLIENT_ID,
    envClientSecret: env.X_API_CLIENT_SECRET,
    handleFallback,
    log,
  });
}

async function main() {
  const env = loadEnv();
  const log = createLogger({ kind: "content-publish", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });
  const notifier = createNotifier({ secrets, log });
  const alerts = createAlertOnce({
    notifier,
    log,
    kinds: ["claim_retained", "uncertain", "lock"] as const,
  });
  const lastMetricsAtMs = new Map<string, number>();

  const boot = await runBootChecks({
    log,
    checks: [{ name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } }],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  log.info({}, "content-publish worker ready");
  installShutdown(log);

  await runWorkerLoop({
    log,
    kind: "content-publish",
    pollMs: env.CONTENT_PUBLISH_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: async () => {
      const instances = await listSendXInternInstances(sql);
      alerts.reconcileInstances(
        instances.map((inst) => ({ orgId: inst.org_id, instanceId: inst.id })),
      );
      const current = new Set(instances.map((inst) => JSON.stringify([inst.org_id, inst.id])));
      for (const [key, at] of lastMetricsAtMs) {
        if (!current.has(key) || Date.now() - at >= env.NOELLE_X_METRICS_MS) lastMetricsAtMs.delete(key);
      }
      return instances;
    },
    onTick: async (inst) => {
      // Shares the send_enabled master gate (0019) — a lock halts posts too.
      if (!isWorkerEnabled(inst, "send")) return;

      const cfg = await sql<Array<{ x_api_write_enabled: boolean; x_api_daily_write_cap: number }>>`
        select x_api_write_enabled, x_api_daily_write_cap
        from noelle.agent_instances where id = ${inst.id} limit 1
      `;
      if (!cfg[0]?.x_api_write_enabled) return;
      const cap = cfg[0].x_api_daily_write_cap ?? 30;

      const client = await buildClient(sql, env, inst.id, null, log);
      // Self-host (`local`) reads image bytes from disk; `gcs` fetches the URL.
      const mediaDir = env.NOELLE_MEDIA_BACKEND === "local" ? env.NOELLE_MEDIA_DIR ?? null : null;
      const outcomes = await runContentPublishTick({
        sql,
        instanceId: inst.id,
        orgId: inst.org_id,
        cap,
        minSpacingMs: env.CONTENT_PUBLISH_MIN_SPACING_MS,
        client,
        mediaDir,
        ...(env.NOELLE_MEDIA_BACKEND === "gcs" ? { resolveMediaUrls: (ids: string[]) => resolveContentMedia({
          apiUrl: env.CP_BASE_URL, hmacSecret: env.NOELLE_HMAC_SECRET,
          orgId: inst.org_id, agentInstanceId: inst.id, ids,
        }) } : {}),
      });

      const preparationFailure = outcomes.find((outcome) => outcome.failurePhase);
      if (preparationFailure) {
        log.warn({ instance: inst.id, slotId: preparationFailure.slotId, failurePhase: preparationFailure.failurePhase,
          claimRetained: preparationFailure.claimRetained, budgetReservationUncertain: preparationFailure.budgetReservationUncertain }, "publish preparation failed before dispatch");
        if (preparationFailure.claimRetained) await alerts.notify({
          instanceId: inst.id,
          kind: "claim_retained",
          orgId: inst.org_id,
          title: "X publishing claim needs recovery",
          message: `Slot ${preparationFailure.slotId} failed before posting during ${preparationFailure.failurePhase}. No post was dispatched. Claim restoration failed; inspect the retained publishing claim.${preparationFailure.budgetReservationUncertain ? " A write-budget reservation may be retained." : ""}`,
        });
      }

      const uncertain = outcomes.find((outcome) => outcome.status === "uncertain" || outcome.status === "duplicate");
      if (uncertain) {
        log.warn({ instance: inst.id, slotId: uncertain.slotId, receipt: uncertain.receipt,
          reconciliationPersisted: uncertain.reconciliationPersisted }, "publish requires reconciliation");
        await alerts.notify({
          instanceId: inst.id,
          kind: "uncertain",
          orgId: inst.org_id,
          title: "X post needs reconciliation",
          message: `Slot ${uncertain.slotId}: ${uncertain.status === "duplicate" ? "X rejected duplicate content without identifying the existing post." : "The post may already be published."} ${uncertain.receipt ? `Receipt: ${uncertain.receipt.url}. ` : ""}${uncertain.reconciliationPersisted ? "The slot is quarantined." : "Quarantine persistence failed; the publishing claim is retained."} Check the X account before retrying.`,
        });
      }

      // Lock breaker: a lock/challenge halts posting AND replies (shared flag).
      const stop = outcomes.find((o) => o.status === "locked" || o.status === "challenged");
      if (stop) {
        const halted = await haltXSend(sql, { orgId: inst.org_id, instanceId: inst.id }).catch(() => {
          log.error({ instanceId: inst.id, orgId: inst.org_id }, "publish halt persistence failed");
          return false;
        });
        await alerts.notify({
          instanceId: inst.id,
          kind: "lock",
          orgId: inst.org_id,
          title: halted ? "Vega posting halted" : "X account lock — halt unconfirmed",
          message: `X API ${stop.status} — ${halted ? "send_enabled flipped off." : "The send halt was not confirmed in storage; publishing and replies may still be enabled."} Re-verify / reconnect the X account before resuming.`,
        });
      }

      const published = outcomes.filter((o) => o.status === "published").length;
      if (outcomes.length > 0) log.info({ instance: inst.id, published, total: outcomes.length }, "content-publish tick");

      // Throttled real-engagement sweep (GET /2/tweets). Reuses the write-token
      // client; a read costs no write budget. Best-effort — never blocks posting.
      const metricsKey = JSON.stringify([inst.org_id, inst.id]);
      const previousMetricsAt = lastMetricsAtMs.get(metricsKey);
      if (
        env.NOELLE_X_METRICS &&
        (previousMetricsAt === undefined || Date.now() - previousMetricsAt >= env.NOELLE_X_METRICS_MS)
      ) {
        lastMetricsAtMs.set(metricsKey, Date.now());
        try {
          const m = await runContentMetricsTick({
            sql,
            instanceId: inst.id,
            orgId: inst.org_id,
            reader: client,
            windowDays: env.NOELLE_X_SELF_TRACK_WINDOW_DAYS,
            maxPosts: env.NOELLE_X_SELF_TRACK_MAX,
            log,
          });
          if (m.measured > 0) log.info({ instance: inst.id, measured: m.measured, considered: m.postsConsidered }, "content-metrics sweep");
        } catch (err) {
          log.warn({ instance: inst.id, err: (err as Error).message }, "content-metrics sweep failed");
        }
      }
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

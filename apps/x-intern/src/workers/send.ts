import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listSendXInternInstances, isWorkerEnabled } from "../lib/activation.js";
import { recordRun } from "../lib/worker-runs.js";
import { busForInstance } from "../lib/bus.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { createSecretsClient } from "../lib/secrets.js";
import { createReadyCache } from "@noelle/runtime/ready-cache";
import { createXClient, type XClient } from "../lib/x-client.js";
import { createXApiClient, makeRefreshCoordinator, type XWriteClient } from "@noelle/x-client";
import { containsExternalLink, reserveXReplyClaim, releaseXReplyClaim } from "@noelle/runtime";
import { readXApiTokens, saveRefreshedXApiTokens } from "../lib/x-api-tokens.js";
import { createXApiSendClient } from "../lib/x-api-send-client.js";
import { createNotifier, createAlertOnce } from "@noelle/runtime/notifier";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { runSendTick, type PendingDraft } from "./send-tick.js";
import { escalateBackoff, isInCooldown, shouldClearSendBackoff } from "../lib/send-backoff.js";
import { isWithinInterSendFloor, nextSendAllowedAt } from "../lib/send-pacing.js";
import {
  claimAutoSendDue,
  listRetrySendDue,
  releaseAutoSendRowsForReview,
} from "../lib/send-db.js";
import { haltXSend } from "../lib/send-halt-db.js";
import type { JSONValue } from "postgres";

// In-memory per-instance state. The send worker is a single long-lived process,
// so these persist across ticks (no schema needed).
const sendCooldownUntilMs = new Map<string, number>(); // 429 backoff
const rateLimitStreak = new Map<string, number>(); // escalating backoff counter
const nextSendAllowedAtMs = new Map<string, number>(); // cross-tick inter-send floor (in-memory, per instance)

/** Is `date` inside the [startHour,endHour) UTC quiet window? Supports wrap. */
function inQuietWindow(date: Date, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  const h = date.getUTCHours();
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

// Account safety: bird cookie writes go through an UNOFFICIAL client, which trips
// X's 226 "looks automated" flag (that's what locked the account). Writes now go
// through the official X API only. The legacy bird write-path is kept below as
// dead code, gated off — flip this to true ONLY for a deliberate emergency
// restore of the cookie write-path.
const ALLOW_BIRD_WRITE_FALLBACK: boolean = false;

// Hold ALL sends this long after a systemic reply-restriction 403 run (the
// account/app can't reply at all — see XReplyRestrictedError). Long on purpose:
// the condition needs a human (API tier / account restriction), not a retry.
const POLICY_403_COOLDOWN_MS = 6 * 60 * 60_000;

async function main() {
  const env = loadEnv();
  const log = createLogger({ kind: "send", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });
  const readyCache = createReadyCache();
  const notifier = createNotifier({ secrets, log });
  const alerts = createAlertOnce({
    notifier,
    log,
    kinds: ["no-write-client", "write-reconciliation", "lock", "reply-forbidden", "auth", "ratelimit"] as const,
  });

  const boot = await runBootChecks({
    log,
    checks: [
      { name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } },
    ],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  log.info({}, "send worker ready");
  const shouldStop = installShutdown(log);

  await runWorkerLoop({
    log,
    kind: "send",
    pollMs: env.SEND_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: async () => {
      const instances = await listSendXInternInstances(sql);
      alerts.reconcileInstances(
        instances.map((inst) => ({ orgId: inst.org_id, instanceId: inst.id })),
      );
      return instances;
    },
    onTick: async (inst) => {
      // Per-worker gate (0019) — see discovery.ts for rationale.
      if (!isWorkerEnabled(inst, "send")) {
        log.debug({ instance: inst.id }, "send disabled for instance; skipping");
        return;
      }
      // Master reply-sending switch (0081): OFF by default. The operator flips it
      // on from the Vega agent page. Gates the whole send tick (retry queue AND
      // auto-send claims) so nothing posts until sending is explicitly enabled.
      if (inst.reply_send_enabled !== true) {
        log.debug({ instance: inst.id }, "reply sending disabled for instance; skipping");
        return;
      }
      const bus = busForInstance(inst);
      const run = await recordRun({ sql, kind: "send", bus });
      try {
        // NOTE: the stale-reply-approval expiry sweep lives in the DRAFTER
        // (which always ticks), not here — this API send worker is autostart:off
        // and the live reply path is the browser actuator. The send worker still
        // refuses to POST a stale reply via the per-claim age predicates below
        // (claimAutoSendDue + the retry queue), so the API path stays safe if it
        // is ever re-enabled.
        // Prefer the official X API when Vega is connected — OAuth 1.0a OR OAuth
        // 2.0 (Bearer + auto-refresh); the cookie path (bird) is the fallback and
        // fails once ct0/auth_token go stale. Replies posted via the API reserve
        // from the shared daily X-API write budget (combined cap).
        let xClient: XClient;
        const tokens = await readXApiTokens(sql, inst.id);
        let write: XWriteClient | null = null;
        if (tokens) {
          const base = { role: "x_intern" as const, sendEnabled: true, xApiWriteEnabled: true, handle: tokens.xHandle };
          if (tokens.authKind === "oauth1a" && tokens.consumerKey && tokens.consumerSecret && tokens.accessTokenSecret) {
            write = createXApiClient({
              ...base,
              oauth1a: {
                consumerKey: tokens.consumerKey,
                consumerSecret: tokens.consumerSecret,
                accessToken: tokens.accessToken,
                accessTokenSecret: tokens.accessTokenSecret,
              },
            });
          } else if (tokens.authKind === "oauth2" && tokens.accessToken && (tokens.consumerKey || env.X_API_CLIENT_ID)) {
            // OAuth 2.0: access token expires (~2h); the client auto-refreshes via
            // the refresh token + client id/secret. The refresh coordinator
            // serializes rotation across the send/publish/manual-send processes
            // and persists it under an advisory lock (single-use RT safety). The
            // client id falls back to env when the token row lacks a consumer_key.
            write = createXApiClient({
              ...base,
              tokens: {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken ?? undefined,
                expiresAt: tokens.expiresAt ?? undefined,
              },
              clientId: tokens.consumerKey ?? env.X_API_CLIENT_ID,
              clientSecret: tokens.consumerSecret ?? env.X_API_CLIENT_SECRET,
              refreshCoordinator: makeRefreshCoordinator(sql, inst.id, log),
              onTokensRefreshed: (t) => saveRefreshedXApiTokens(sql, inst.id, t),
            });
          }
        }

        if (write && tokens) {
          const [capRow] = await sql<Array<{ cap: number }>>`
            select coalesce(x_api_daily_write_cap, 30) as cap
            from noelle.agent_instances where id = ${inst.id}
          `;
          xClient = createXApiSendClient({
            sql,
            agentInstanceId: inst.id,
            orgId: inst.org_id,
            cap: Number(capRow?.cap ?? 30),
            handle: tokens.xHandle,
            write,
          });
        } else if (ALLOW_BIRD_WRITE_FALLBACK) {
          // DEAD CODE by default (ALLOW_BIRD_WRITE_FALLBACK = false): the legacy
          // bird cookie write-path. Bird is an unofficial client, so posting
          // through it trips X's 226 automation flag. Kept, gated off, for an
          // emergency manual restore only.
          let ct0 = "";
          let authToken = "";
          await readyCache.ensure(inst.org_id, "x-cookies", async () => {
            ct0 = await secrets.getForOrg(inst.org_id, "x-cookies-ct0");
            authToken = await secrets.getForOrg(inst.org_id, "x-cookies-auth-token");
            await createXClient({ ct0, authToken }).verifyCredentials();
          });
          // TTL-cached; cheap re-reads to get current values.
          ct0 = await secrets.getForOrg(inst.org_id, "x-cookies-ct0");
          authToken = await secrets.getForOrg(inst.org_id, "x-cookies-auth-token");
          xClient = createXClient({ ct0, authToken });
        } else {
          // No official X API write client (no valid OAuth token) and the bird
          // write-fallback is disabled for account safety. Skip this send tick —
          // drafts stay pending until a valid X API token exists, and we never
          // post through the flagged cookie path. When due work is actually
          // waiting, PAGE: a silent no-sender is how the 2026-07-11 dead-sender
          // condition went unnoticed for 8 days.
          log.warn({ instance: inst.id }, "send skipped: no official X API write client; bird write-fallback disabled");
          const [due] = await sql<Array<{ retry: number; stamped: number }>>`
            select
              (select count(*)::int
                 from noelle.approvals a
                 join noelle.drafts d on d.id = a.draft_id
                 join noelle.leads l  on l.id = d.lead_id
                where a.status = 'sent'
                  and d.sent_external_id is null
                  and d.sent_at is null
                  and l.agent_instance_id = ${inst.id}
                  and coalesce(d.payload->>'kind', 'reply') <> 'dm') as retry,
              (select count(*)::int
                 from noelle.approvals

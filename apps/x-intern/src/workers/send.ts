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
                where agent_instance_id = ${inst.id}
                  and status = 'pending'
                  and auto_send_target_at is not null
                  and auto_send_target_at <= now()) as stamped
          `;
          const dueTotal = (due?.retry ?? 0) + (due?.stamped ?? 0);
          if (dueTotal > 0) {
            await alerts.notify({
              instanceId: inst.id,
              kind: "no-write-client",
              orgId: inst.org_id,
              title: "X sender has no write client — replies waiting",
              message:
                `${dueTotal} due repl${dueTotal === 1 ? "y" : "ies"} (retry ${due?.retry ?? 0}, stamped ${due?.stamped ?? 0}) ` +
                `but the send worker has no valid X API token. Reconnect the X account under Connections.`,
              throttleMs: 6 * 60 * 60_000,
            });
          }
          await run.finish({ status: "ok", rowsProcessed: 0 });
          return;
        }

        // Approval send flow:
        //   - dashboard's POST /api/drafts/:id/send only flips approvals.status
        //     and stamps decided_at; it does NOT touch drafts.sent_at.
        //   - draft text lives at payload->>'body' (or edited_body if the user
        //     edited it in the UI before approving) — there is no drafts.body
        //     column in the current schema.
        //   - approvals join key is draft_id (no sent_draft_id column).
        // 1. Retry queue: rows already flipped to 'sent' (by a founder click
        //    or a prior auto-send claim) that the X post didn't complete on.
        const pendingRows = await listRetrySendDue(sql, {
          agentInstanceId: inst.id, orgId: inst.org_id, maxAgeHours: env.X_REPLY_MAX_AGE_HOURS,
        });
        let pending: PendingDraft[] = [...pendingRows];
        // Belt-and-suspenders for the retry lane: an auto-claimed row that
        // carries an external link must never post unattended, even via retry
        // (a failed link-guard revert can leave one 'sent' with no external
        // id). Human-decided rows keep their links — the operator approved
        // them deliberately.
        if (env.NOELLE_AUTOSEND_BLOCK_EXTERNAL_LINKS) {
          const linkyRetry = pending.filter(
            (r) => r.decided_by === "auto-send" && containsExternalLink(r.body),
          );
          if (linkyRetry.length > 0) {
            await releaseAutoSendRowsForReview(sql, { draftIds: linkyRetry.map((r) => r.draft_id) })
              .catch((e) => log.error({ err: (e as Error).message }, "failed to release link retry rows for review"));
            log.warn(
              { org_id: inst.org_id, released: linkyRetry.length },
              "retry rows carried external links (auto-claimed); reverted to pending for human review",
            );
            pending = pending.filter((r) => !(r.decided_by === "auto-send" && containsExternalLink(r.body)));
          }
        }

        // 2. Auto-send pickup: any approval whose auto_send_target_at is now
        //    due — whether the drafter scheduled it (always-on auto-send mode)
        //    OR the operator queued a batch from the inbox. NOT gated on
        //    auto_send_enabled: a queued batch must fire on its staggered
        //    schedule even with always-on mode off. Rolling half-hour, hour,
        //    and daily budgets are checked atomically when claiming due work.
        // Window gates BEFORE claiming new auto-sends. A 429 cooldown blocks ALL
        // writes this tick (X is actively throttling); the overnight quiet
        // window blocks only NEW auto-sends (a stuck-send retry may still
        // complete). The half-hour budget bounds short bursts.
        const nowMs = Date.now();
        // Persisted 429 cooldown (X_PERSIST_SEND_COOLDOWN, default OFF). Read is
        // gated behind the flag (off ⇒ zero extra query, exactly today's in-memory
        // logic) and FAILS CLOSED: any read error ⇒ assume throttled and skip ALL
        // sends this tick. Also seeds the in-memory streak so the ladder continues
        // across a deploy-restart. Sits inside the onTick try (which rethrows).
        let persistedCooldownUntil: number | null = null;
        if (env.X_PERSIST_SEND_COOLDOWN) {
          try {
            const [row] = await sql<Array<{ until: Date | null; streak: number }>>`
              select send_cooldown_until as until, rate_limit_streak as streak
              from noelle.agent_instances where id = ${inst.id}`;
            persistedCooldownUntil = row?.until ? new Date(row.until).getTime() : null;
            const ps = Number(row?.streak ?? 0);
            if (ps > 0 && !rateLimitStreak.has(inst.id)) rateLimitStreak.set(inst.id, ps); // continue the ladder across restart
          } catch (e) {
            persistedCooldownUntil = nowMs + 1; // FAIL CLOSED: can't read state -> assume throttled, skip sends this tick
            log.warn({ instance: inst.id, err: (e as Error).message }, "cooldown read failed; failing closed");
          }
        }
        const inCooldown = isInCooldown(persistedCooldownUntil, sendCooldownUntilMs.get(inst.id), nowMs);
        const quiet = inQuietWindow(
          new Date(nowMs),
          env.AUTOSEND_QUIET_START_UTC,
          env.AUTOSEND_QUIET_END_UTC,
        );
        // Cross-tick inter-send floor (NOELLE_AUTOSEND_INTERSEND_FLOOR, default OFF).
        // When active, no send fires this tick (a jittered gap since the last
        // successful post hasn't elapsed). Off ⇒ floorActive always false.
        const floorEnabled = env.NOELLE_AUTOSEND_INTERSEND_FLOOR;
        const floorActive =
          floorEnabled &&
          isWithinInterSendFloor({ nowMs, nextSendAllowedAtMs: nextSendAllowedAtMs.get(inst.id) });
        let claimed: PendingDraft[] = [];
        if (inCooldown) {
          log.info(
            { org_id: inst.org_id, cooldownUntil: sendCooldownUntilMs.get(inst.id) },
            "send in 429 cooldown; skipping all sends this tick",
          );
        } else if (floorActive) {
          log.debug(
            { org_id: inst.org_id, nextAllowed: nextSendAllowedAtMs.get(inst.id) },
            "send within inter-send floor; deferring all sends this tick",
          );
        } else if (quiet) {
          log.debug({ org_id: inst.org_id }, "send in overnight quiet window; deferring new auto-sends");
        } else {
          claimed = await claimAutoSendDue(sql, {
            agentInstanceId: inst.id,
            budget: floorEnabled ? 1 : 2,
            maxAgeHours: env.X_REPLY_MAX_AGE_HOURS,
            maxPerDay: env.AUTOSEND_MAX_PER_DAY,
            maxPer30Min: env.AUTOSEND_MAX_PER_30MIN,
          });
          if (claimed.length > 0) {
            log.info({ org_id: inst.org_id, claimed: claimed.length }, "auto-send rows claimed within rolling budgets");
            // Belt-and-suspenders link guard (default ON): the drafter already
            // withholds link-bearing auto-sends, but revert any that were already
            // stamped (or slipped through) so nothing with an external link posts
            // unattended. Only claimed (decided_by='auto-send') rows are touched —
            // never a human Send-button click. Fail closed: even if the DB revert
            // errors, the row is still dropped from `claimed` so it can't post this
            // tick.
            if (env.NOELLE_AUTOSEND_BLOCK_EXTERNAL_LINKS && claimed.length > 0) {
              const linky = claimed.filter((r) => containsExternalLink(r.body));
              if (linky.length > 0) {
                await releaseAutoSendRowsForReview(sql, { draftIds: linky.map((r) => r.draft_id) })
                  .catch((e) => log.error({ err: (e as Error).message }, "failed to release link auto-sends for review"));
                log.warn(
                  { org_id: inst.org_id, released: linky.length },
                  "auto-send rows carried external links; reverted to pending for human review",
                );
                claimed = claimed.filter((r) => !containsExternalLink(r.body));
              }
            }
          }
        }

        // Cooldown OR floor active => send nothing this tick. Floor ON => at most ONE
        // reply/tick (retry queue first, then an auto claim) so two rows can't post
        // back-to-back; a lock/auth/429 inside runSendTick still short-circuits per-draft.
        const toSend =
          inCooldown || floorActive
            ? []
            : floorEnabled
              ? [...pending, ...claimed].slice(0, 1)
              : [...pending, ...claimed];
        const outcomes = await runSendTick({
          log,
          // 429 cooldown also suspends the stuck-send retry queue — pounding X
          // while throttled lengthens the lock.
          pendingDrafts: toSend,
          xClient,
          reserveReply: (draft) => reserveXReplyClaim(sql, {
            orgId: inst.org_id,
            draftId: draft.draft_id,
            targetTweetId: draft.in_reply_to_id,
            mode: "worker",
          }),
          releaseReply: (claim) => releaseXReplyClaim(sql, claim),
          markUncertain: async ({ draftId, reason, receipt }) => {
            await sql`
              update noelle.drafts
              set payload = payload || ${sql.json({
                send_reconciliation_required: true,
                send_reconciliation_reason: reason,
                ...(receipt ? { send_reconciliation_receipt: receipt } : {}),
              } as unknown as JSONValue)}::jsonb
              where id = ${draftId} and org_id = ${inst.org_id}
            `;
          },
          markSent: async ({ draftId, sentExternalId, sentUrl }) => {
            const rows = await sql<Array<{ id: string }>>`
              update noelle.drafts
              set sent_external_id = ${sentExternalId},
                  posted_at = now(),
                  payload = payload || ${sql.json({ sent_url: sentUrl } as unknown as JSONValue)}::jsonb
              where id = ${draftId} and org_id = ${inst.org_id}
              returning id
            `;
            if (!rows[0]) throw new Error("reply receipt row unavailable");
          },
          markErrored: async ({ draftId, reason }) => {
            // Flip the approval row attached to this draft to 'errored'
            // and stash the reason so the dashboard can show it. Failure
            // here is logged but doesn't block the tick — the next tick
            // will re-claim the row (because status is still 'sent') and
            // hit the same error again, which is fine: idempotent retry.
            try {
              await sql`
                update noelle.approvals
                set status = 'errored',
                    decided_at = coalesce(decided_at, now()),
                    skip_reason = ${`send-failed: ${reason.slice(0, 480)}`}
                where draft_id = ${draftId}

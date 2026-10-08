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
                  and org_id = ${inst.org_id}
                  and status = 'sent'
              `;
            } catch (err) {
              log.error(
                { draftId, err: (err as Error).message },
                "markErrored: approval flip failed",
              );
            }
          },
        });

        const uncertain = outcomes.find((outcome) => outcome.status === "uncertain");
        if (uncertain) {
          const halted = await haltXSend(sql, { orgId: inst.org_id, instanceId: inst.id }).catch(() => {
            log.error({ instanceId: inst.id }, "failed to pause sends; uncertain target claim remains reserved");
            return false;
          });
          await alerts.notify({
            instanceId: inst.id,
            kind: "write-reconciliation",
            orgId: inst.org_id,
            title: halted ? "X reply requires reconciliation — sends paused" : "X reply requires reconciliation — halt unconfirmed",
            message: `Draft ${uncertain.draftId} has an unconfirmed dispatch or an unpersisted receipt. Its target reservation and write budget remain held.${halted ? "" : " The send halt was not confirmed in storage; other sends may still be enabled."} Check the account's recent replies and record the actual outcome before resuming sends.`,
          });
        }

        // CIRCUIT-BREAKER: an account lock / automation flag / human challenge.
        // Disable Send for this instance so NO further writes fire until a human
        // clears it + re-enables. Never auto-retry a lock — that's the documented
        // fastest path to permanent suspension.
        const stop = outcomes.find((o) => o.status === "locked" || o.status === "challenged");
        if (stop) {
          const halted = await haltXSend(sql, { orgId: inst.org_id, instanceId: inst.id }).catch(() => {
            log.error({ instanceId: inst.id }, "failed to disable send on lock");
            return false;
          });
          readyCache.reset(inst.org_id, "x-cookies");
          await alerts.notify({
            instanceId: inst.id,
            kind: "lock",
            orgId: inst.org_id,
            title: halted ? "🚨 X account locked — auto-send DISABLED" : "X account locked — halt unconfirmed",
            message:
              `X flagged the account (${stop.status}): ${(stop.reason ?? "").slice(0, 200)}.\n` +
              `${halted ? "Auto-send is now OFF for this agent." : "The send halt was not confirmed in storage; sends may still be enabled."} Clear the challenge on X (and re-grab cookies if asked), then re-enable Send in the dashboard. Do NOT mass-delete posts.`,
          });
        }

        // Reply-restriction 403s ("not been mentioned or otherwise engaged"):
        // ONE is a per-conversation condition — that row already errored inside
        // the tick. A consecutive run (REPLY_FORBIDDEN_TRIP) is systemic — the
        // account/app cannot reply at all right now — so hold all sends for
        // POLICY_403_COOLDOWN_MS, hand unattempted auto-claims back to the
        // review inbox, and page. This is the guard the 2026-07-11 storm was
        // missing (65 identical 403s terminally errored 118 approvals).
        const forbidden = outcomes.filter((o) => o.status === "reply_forbidden");
        // Systemic = runSendTick actually broke on a CONSECUTIVE streak (the
        // row it broke on carries systemic:true). NOT a total count of
        // reply_forbidden rows — two unrelated per-conversation 403s with a
        // successful send between them must NOT trip the account-wide halt.
        const systemicForbidden = forbidden.some((o) => o.systemic === true);
        if (forbidden.length > 0) {
          let released = 0;
          if (systemicForbidden) {
            const until = Date.now() + POLICY_403_COOLDOWN_MS;
            sendCooldownUntilMs.set(inst.id, until);
            if (env.X_PERSIST_SEND_COOLDOWN) {
              await sql`update noelle.agent_instances set send_cooldown_until = ${new Date(until)} where id = ${inst.id}`.catch(
                (e) => log.error({ err: (e as Error).message }, "persist policy-403 cooldown failed"),
              );
            }
            const unattempted = toSend.slice(outcomes.length);
            if (unattempted.length > 0) {
              released = unattempted.length;
              await releaseAutoSendRowsForReview(sql, { draftIds: unattempted.map((d) => d.draft_id) }).catch(
                (e) => log.error({ err: (e as Error).message }, "failed to release unattempted rows after policy 403"),
              );
            }
            log.error(
              { org_id: inst.org_id, forbidden: forbidden.length, released, cooldownMin: POLICY_403_COOLDOWN_MS / 60_000 },
              "systemic reply-restriction 403 — all sends cooled down",
            );
          }
          await alerts.notify({
            instanceId: inst.id,
            kind: "reply-forbidden",
            orgId: inst.org_id,
            title:
              systemicForbidden
                ? "🚫 X refuses ALL replies (403) — sends paused"
                : "X refused a reply (403 restriction)",
            message:
              systemicForbidden
                ? `${forbidden.length} consecutive "reply not allowed" 403s — the account/app has likely lost reply permission (API tier, scope, or account restriction). Sends are paused ${POLICY_403_COOLDOWN_MS / 3_600_000}h; ${released} unattempted repl${released === 1 ? "y was" : "ies were"} returned to the inbox. Verify with ONE manual reply to a fresh tweet before re-enabling.`
                : `X refused one reply with a who-can-reply restriction: ${(forbidden[0]?.reason ?? "").slice(0, 180)}. The row was errored; nothing else was touched.`,
          });
        }

        const authFailed = outcomes.some((o) => o.status === "auth_failed");
        if (authFailed) {
          // Wipe the ready-cache so the next tick re-pulls creds, and alert the
          // operator to reconnect. The fix instruction depends on WHICH auth path
          // failed: the OAuth 2.0 token (reconnect under Connections), OAuth 1.0a
          // API keys, or the cookie fallback (re-grab ct0 + auth_token). `write`
          // is non-null only when the official X API path ran.
          readyCache.reset(inst.org_id, "x-cookies");
          const apiAuthKind = write ? tokens?.authKind : undefined;
          const alert =
            apiAuthKind === "oauth2"
              ? {
                  title: "X API token expired — reconnect",
                  message:
                    "Auto-send hit an auth failure on the X API OAuth 2.0 token (the refresh chain broke). Reconnect the X account under Connections to mint a fresh token. Sends pause until valid.",
                }
              : apiAuthKind === "oauth1a"
                ? {
                    title: "X API keys invalid — reconnect",
                    message:
                      "Auto-send hit an auth failure on the X API keys (OAuth 1.0a). Check / re-enter the X API keys under Connections. Sends pause until valid.",
                  }
                : {
                    title: "X cookies invalid — reconnect",
                    message:
                      "Auto-send hit an auth failure (cookies dead/stale). Re-grab ct0 + auth_token. Sends pause until valid.",
                  };
          await alerts.notify({ instanceId: inst.id, kind: "auth", orgId: inst.org_id, ...alert });
        }

        // Escalating backoff on 429: 15 → 30 → 60 → cap 120 min (pure escalateBackoff).
        // A clean tick (something actually sent) resets the streak + cooldown. When
        // X_PERSIST_SEND_COOLDOWN is on we also persist the new cooldown+streak so a
        // deploy-restart can't resume posting into a throttled account, and clear
        // them on success — but ONLY when state actually existed (no per-post churn).
        const rateLimited = outcomes.some((o) => o.status === "rate_limited");
        const sentSomething = outcomes.some((o) => o.status === "sent");
        if (rateLimited) {
          const b = escalateBackoff(rateLimitStreak.get(inst.id) ?? 0, Date.now());
          rateLimitStreak.set(inst.id, b.streak);
          sendCooldownUntilMs.set(inst.id, b.cooldownUntilMs);
          if (env.X_PERSIST_SEND_COOLDOWN) {
            await sql`update noelle.agent_instances set send_cooldown_until = ${new Date(b.cooldownUntilMs)}, rate_limit_streak = ${b.streak} where id = ${inst.id}`
              .catch((e) => log.error({ err: (e as Error).message }, "persist send cooldown failed"));
          }
          log.warn({ org_id: inst.org_id, cooldownMin: b.mins, streak: b.streak }, "send rate-limited; backing off");
          await alerts.notify({
            instanceId: inst.id,
            kind: "ratelimit",
            orgId: inst.org_id,
            title: "X rate-limited auto-send",
            message: `Backing off ${b.mins} min (streak ${b.streak}).`,
            throttleMs: 60 * 60_000,
          });
        } else if (shouldClearSendBackoff({ sent: sentSomething, rateLimited, systemicForbidden })) {
          // A clean send clears the 429 backoff — but NOT when a systemic
          // reply-restriction 403 set the policy cooldown earlier THIS tick
          // (1 send + 2 forbidden can co-occur before the batch breaks). The
          // policy cooldown is a different axis and must survive; otherwise we
          // resume posting straight into the account/app reply block.
          const had = rateLimitStreak.has(inst.id) || sendCooldownUntilMs.has(inst.id) || persistedCooldownUntil != null;
          rateLimitStreak.delete(inst.id);
          sendCooldownUntilMs.delete(inst.id);
          if (env.X_PERSIST_SEND_COOLDOWN && had) {
            await sql`update noelle.agent_instances set send_cooldown_until = null, rate_limit_streak = 0 where id = ${inst.id}`
              .catch((e) => log.error({ err: (e as Error).message }, "clear send cooldown failed"));
          }
        }

        const sent = outcomes.filter((o) => o.status === "sent");
        for (const o of sent) {
          await bus.emit({
            topic: "draft.sent",
            worker: "send",
            summary: "sent reply to X",
            payload: { lead_id: o.leadId, draft_id: o.draftId, external_id: o.sentExternalId, url: o.sentUrl },
            // correlation_id chains a lead's journey across workers — use the lead
            // id (like every other event), not the draft id.
            correlationId: o.leadId ?? o.draftId,
          });
        }
        // Stamp the inter-send floor off the last successful post; next tick waits a
        // fresh jittered gap. No-op when the flag is off (map stays empty).
        if (floorEnabled && outcomes.some((o) => o.status === "sent")) {
          nextSendAllowedAtMs.set(
            inst.id,
            nextSendAllowedAt({
              nowMs: Date.now(),
              minMs: env.AUTOSEND_INTERSEND_MIN_MS,
              maxMs: env.AUTOSEND_INTERSEND_MAX_MS,
              rand: Math.random(),
            }),
          );
        }
        const preparationFailure = outcomes.find((outcome) => outcome.status === "preparation_failed" || outcome.status === "claim_unavailable" || outcome.status === "uncertain");
        await run.finish(preparationFailure
          ? { status: "error", rowsProcessed: sent.length, errorMessage: preparationFailure.reason ?? "reply preparation unavailable" }
          : { status: "ok", rowsProcessed: sent.length });
      } catch (err) {
        readyCache.reset(inst.org_id, "x-cookies");
        await run.finish({ status: "error", errorMessage: (err as Error).message });

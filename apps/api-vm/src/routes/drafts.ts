import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  DraftSendInSchema,
  DraftSkipInSchema,
  DraftMarkSentInSchema,
  ScheduleAutoSendInSchema,
  BulkSkipInSchema,
  type DraftSendIn,
  type DraftSkipIn,
  type ScheduleAutoSendIn,
  type BulkSkipIn,
} from "@noelle/contracts";
import { markApprovalSent, undoManualSent } from "../lib/manual-sent-db.js";
import { scheduleAutoSendApprovals } from "../lib/autosend-schedule-db.js";
import {
  createSecretsClient,
  SecretAccessError,
  type SecretsClient,
} from "@noelle/secrets";
import {
  createXClient,
  createXApiClient,
  makeRefreshCoordinator,
  XAuthError,
  XError,
  XRateLimitError,
  XLockError,
  XChallengeError,
  XWriteUncertainError,
  isDefiniteXWriteRejection,
  type XClient,
  type XWriteClient,
  type CreateXClientOpts,
} from "@noelle/x-client";
import { reserveXReplyClaim, releaseXReplyClaim, reserveXApiWrite, releaseXApiWrite, type XReplyClaim, type XApiWriteReservation } from "@noelle/runtime";
import {
  ApprovalMutationError,
  skipApproval,
  restoreSkippedApproval,
  parkApprovalDm,
  saveApprovalEdit,
  bulkSkipApprovals,
} from "@noelle/runtime";
import { isOrgMember } from "../lib/auth.js";
import { noelleDb } from "../lib/db.js";
import { loadEnv } from "../env.js";
import type { AuthContext } from "../middleware/jwt.js";

// POST /api/drafts/:id/send — Hono route called from the dashboard's
// /approvals/[approvalId] Send button.
//
// As of the synchronous-send refactor this route posts the reply to X
// inline (createTweet via @noelle/x-client) BEFORE flipping the approval
// status. The dashboard now learns immediately whether the click resulted
// in a live tweet, with sent_external_id + sent_url in the response.
//
// Manual, worker and browser sends share a durable per-target claim. A known
// rejection can release it; a confirmed or uncertain write keeps it reserved
// even if saving the receipt fails, preventing concurrent clicks and retries.

const drafts = new Hono<{ Variables: { auth: AuthContext } }>();

// ---------------------------------------------------------------------------
// Send-path dependency injection. Tests override these to avoid needing real
// Secret Manager / X cookies / network. Production paths fall back to the
// real factories on first use and cache the singleton.
// ---------------------------------------------------------------------------

export type XClientFactory = (opts: CreateXClientOpts) => XClient;

let _secrets: SecretsClient | null = null;
let _xClientFactory: XClientFactory = createXClient;

function getSecrets(): SecretsClient {
  if (_secrets) return _secrets;
  const env = loadEnv();
  _secrets = createSecretsClient({ project: env.GCP_PROJECT });
  return _secrets;
}

export function __setSendDepsForTests(deps: {
  secrets?: SecretsClient;
  xClientFactory?: XClientFactory;
}): void {
  if (deps.secrets) _secrets = deps.secrets;
  if (deps.xClientFactory) _xClientFactory = deps.xClientFactory;
}

export function __resetSendDepsForTests(): void {
  _secrets = null;
  _xClientFactory = createXClient;
}

/**
 * Read Vega's OAuth 1.0a X-API creds for a manual reply send. Returns null
 * unless the instance has a complete oauth1a token row — callers then fall back
 * to the cookie path.
 */
// Build Vega's official X API write client for a manual reply send — OAuth 1.0a
// OR OAuth 2.0 (Bearer + auto-refresh). Returns null when no complete X-API creds
// exist, so callers fall back to the cookie path. A manual send is human-authorized
// (sendEnabled:true) — that flag gates the autonomous worker, not this path.
async function buildVegaXApiClient(
  sql: ReturnType<typeof noelleDb>,
  instanceId: string,
): Promise<XWriteClient | null> {
  const [t] = await sql<
    Array<{
      auth_kind: string;
      access_token: string;
      refresh_token: string | null;
      access_token_expires_at: string | null;
      consumer_key: string | null;
      consumer_secret: string | null;
      access_token_secret: string | null;
      x_handle: string | null;
    }>
  >`
    select auth_kind, access_token, refresh_token, access_token_expires_at,
           consumer_key, consumer_secret, access_token_secret, x_handle
    from noelle.x_api_tokens
    where agent_instance_id = ${instanceId}
    limit 1
  `;
  if (!t) return null;
  const base = { role: "x_intern" as const, sendEnabled: true, xApiWriteEnabled: true, handle: t.x_handle };
  if (t.auth_kind === "oauth1a" && t.consumer_key && t.consumer_secret && t.access_token_secret) {
    return createXApiClient({
      ...base,
      oauth1a: {
        consumerKey: t.consumer_key,
        consumerSecret: t.consumer_secret,
        accessToken: t.access_token,
        accessTokenSecret: t.access_token_secret,
      },
    });
  }
  const env = loadEnv();
  if (t.auth_kind === "oauth2" && t.access_token && (t.consumer_key || env.X_API_CLIENT_ID)) {
    return createXApiClient({
      ...base,
      tokens: {
        accessToken: t.access_token,
        refreshToken: t.refresh_token ?? undefined,
        expiresAt: t.access_token_expires_at ? new Date(t.access_token_expires_at).getTime() : undefined,
      },
      clientId: t.consumer_key ?? env.X_API_CLIENT_ID,
      clientSecret: t.consumer_secret ?? env.X_API_CLIENT_SECRET,
      // Serialize + persist rotation under an advisory lock so the manual /send
      // path never races the send / content-publish workers on the single-use RT.
      refreshCoordinator: makeRefreshCoordinator(sql, instanceId),
      onTokensRefreshed: async (nt) => {
        await sql`
          update noelle.x_api_tokens
             set access_token = ${nt.accessToken},
                 refresh_token = coalesce(${nt.refreshToken ?? null}, refresh_token),
                 access_token_expires_at = coalesce(
                   ${nt.expiresAt ? new Date(nt.expiresAt).toISOString() : null},
                   access_token_expires_at
                 )
           where agent_instance_id = ${instanceId}
        `;
      },
    });
  }
  return null;
}

drafts.post("/api/drafts/:id/send", async (c) => {
  const auth = c.get("auth");
  const approvalId = c.req.param("id");

  let payload: DraftSendIn;
  try {
    const raw = await c.req.json().catch(() => ({}));
    payload = DraftSendInSchema.parse(raw);
  } catch (err) {
    return c.json(
      {
        error: "invalid_body",
        detail: err instanceof Error ? err.message : String(err),
      },
      400,
    );
  }

  const sql = noelleDb();

  // Single round-trip: pull the approval row plus the linked draft body and
  // the lead's tweet id (external_id is the in_reply_to anchor for X).
  let row:
    | {
        id: string;
        org_id: string;
        agent_instance_id: string;
        draft_id: string;
        lead_id: string;
        status: string;
        decided_at: string | null;
        lead_external_id: string | null;
        draft_kind: string | null;
      }
    | undefined;
  try {
    const rows = await sql<
      Array<{
        id: string;
        org_id: string;
        agent_instance_id: string;
        draft_id: string;
        lead_id: string;
        status: string;
        decided_at: string | null;
        lead_external_id: string | null;
        draft_kind: string | null;
      }>
    >`
      select a.id              as id,
             a.org_id          as org_id,
             a.agent_instance_id as agent_instance_id,
             a.draft_id        as draft_id,
             a.lead_id         as lead_id,
             a.status          as status,
             a.decided_at      as decided_at,
             l.external_id     as lead_external_id,
             d.payload->>'kind' as draft_kind
      from noelle.approvals a
      left join noelle.leads l  on l.id = a.lead_id and l.org_id = a.org_id
      left join noelle.drafts d on d.id = a.draft_id and d.org_id = a.org_id
      where a.id = ${approvalId}
      limit 1
    `;
    row = rows[0];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "internal", detail: msg }, 500);
  }
  if (!row) {
    return c.json({ error: "not_found" }, 404);
  }
  if (!(await isOrgMember(auth.userId, row.org_id))) {
    return c.json({ error: "not_org_member" }, 403);
  }

  // Draft-only gate: only an x_intern (Vega) may post to X. A MANUAL send from
  // the dashboard is human-authorized (the operator clicked Send), so it does
  // NOT require send_enabled — that flag gates the AUTONOMOUS worker, not manual
  // sends. Draft-only agents (no x_intern row) are still blocked.
  const [vega] = await sql<Array<{ id: string; x_api_write_enabled: boolean }>>`
    select id, x_api_write_enabled from noelle.agent_instances
    where id = ${row.agent_instance_id} and org_id = ${row.org_id} and role = 'x_intern'
    limit 1
  `;
  if (!vega) {
    return c.json({ error: "not_permitted", detail: "No X intern for this org — this content can't post to X." }, 403);
  }

  // Idempotency: already sent / skipped / expired.
  if (row.status === "sent") {
    return c.json({
      approval_id: row.id,
      draft_id: row.draft_id,
      status: "sent" as const,
      sent_at: row.decided_at ?? new Date().toISOString(),
    });
  }
  if (row.status === "skipped" || row.status === "expired") {
    return c.json({ error: "already_actioned", detail: row.status }, 409);
  }

  // DM drafts are manual-send. The founder copies the DM and sends it on X
  // by hand, then clicks "Mark as sent" here. We NEVER post a DM through the
  // reply API (createTweet), and we do NOT skip the reply siblings — the
  // three replies for this lead stay independently reviewable. "Send" here
  // only records that the founder dispatched the DM (status → 'sent', no
  // sent_external_id / sent_url, since nothing was posted by us).
  if (row.draft_kind === "dm") {
    const now = new Date().toISOString();
    try {
      await sql.begin(async (tx) => {
        if (payload.edited) {
          await tx`
            update noelle.drafts
            set payload = coalesce(payload, '{}'::jsonb)
                          || ${tx.json({ edited_body: payload.body })}
            where id = ${row!.draft_id}
          `;
        }
        await tx`
          update noelle.approvals
          set status = 'sent',
              decided_at = ${now},
              decided_by = ${auth.userId}
          where id = ${row!.id}
        `;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: "internal", detail: msg }, 500);
    }
    return c.json({
      approval_id: row.id,
      draft_id: row.draft_id,
      status: "sent" as const,
      sent_at: now,
    });
  }

  if (!row.lead_external_id) {
    return c.json(
      {
        error: "missing_in_reply_to",
        detail: "lead has no external_id; cannot post reply to X",
      },
      422,
    );
  }

  // --- Post the reply ---
  // Prefer the official X API (OAuth 1.0a OR OAuth 2.0) when Vega is connected;
  // the cookie path (@steipete/bird) is the fallback and fails once ct0/auth_token
  // go stale.
  const apiWrite = vega.x_api_write_enabled ? await buildVegaXApiClient(sql, vega.id) : null;
  let tweet: { id: string; url: string };
  let likeClient: XClient | null = null; // bird only — the X API client is post-only (no like)
  let claim: XReplyClaim | null = null;
  let dispatched = false;
  let writeReservation: XApiWriteReservation | null = null;
  try {
    let dispatch: () => Promise<{ id: string; url: string }>;
    if (apiWrite) {
      dispatch = () => apiWrite.postTweet({ text: payload.body, inReplyToId: row!.lead_external_id! });
    } else {
      const secrets = getSecrets();
      const [ct0, authToken] = await Promise.all([
        secrets.getForOrg(row.org_id, "x-cookies-ct0"),
        secrets.getForOrg(row.org_id, "x-cookies-auth-token"),
      ]);
      likeClient = _xClientFactory({ ct0, authToken });
      dispatch = () => likeClient!.createTweet({
        inReplyToId: row!.lead_external_id!,
        text: payload.body,
      });
    }
    try {
      claim = await reserveXReplyClaim(sql, { orgId: row.org_id, draftId: row.draft_id,
        targetTweetId: row.lead_external_id, mode: "manual" });
    } catch {
      return c.json({ error: "x_reply_reservation_failed", detail: "No reply was dispatched. Check the target reservation before retrying." }, 500);
    }
    if (!claim) return c.json({ error: "x_reply_already_reserved", detail: "This target is already reserved, answered, or no longer sendable. Reconcile the X account before retrying." }, 409);
    if (apiWrite) {
      try {
        // A deliberate manual send overrides the automatic cap and still charges it.
        writeReservation = await reserveXApiWrite(sql, { orgId: row.org_id, agentInstanceId: vega.id, cap: 0, override: true });
      } catch {
        await releaseXReplyClaim(sql, claim).catch(() => false);
        return c.json({ error: "x_write_budget_unavailable", detail: "No reply was dispatched. The budget reservation result is unknown and may remain charged; the target can be retried after storage recovers." }, 500);
      }
      if (!writeReservation) {
        await releaseXReplyClaim(sql, claim).catch(() => false);
        return c.json({ error: "x_write_budget_unavailable", detail: "No reply was dispatched. This X instance cannot reserve its write budget." }, 409);
      }
    }
    dispatched = true;
    tweet = await dispatch();
  } catch (err) {
    const knownRejected = isDefiniteXWriteRejection(err);
    if (writeReservation && (!dispatched || knownRejected)) await releaseXApiWrite(sql, writeReservation).catch(() => {});
    if (claim && (!dispatched || knownRejected)) await releaseXReplyClaim(sql, claim).catch(() => false);
    if (dispatched && !knownRejected) {
      const receipt = err instanceof XWriteUncertainError ? err.receipt : undefined;
      return c.json({ error: "x_write_uncertain", detail: "The reply may already be posted. Its target remains reserved; reconcile the X account before retrying.",
        ...(receipt ? { sent_external_id: receipt.id, sent_url: receipt.url } : {}) }, 502);
    }
    if (err instanceof SecretAccessError && /NOT_FOUND/.test(err.message)) {
      return c.json(
        {
          error: "x_cookies_missing",
          detail: "X isn't connected for this org. Add your X API keys under Connections (or reconnect cookies) so Vega can post.",
        },
        409,
      );
    }
    if (err instanceof XLockError || err instanceof XChallengeError) {
      return c.json(
        {
          error: "x_account_locked",
          detail:
            `X flagged the account (${err instanceof XLockError ? "locked / looks automated" : "human challenge"}): ${err.message}. ` +
            `STOP sending and clear it on x.com. Retrying now risks suspension.`,
        },
        503,
      );
    }
    if (err instanceof XAuthError) {
      const detail = err.message
        ? `X rejected the post (auth): ${err.message}. Check the X API keys under Connections (or, on the cookie fallback, re-grab ct0 + auth_token).`
        : "X credentials are no longer valid. Reconnect the X account under Connections.";

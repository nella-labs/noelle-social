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

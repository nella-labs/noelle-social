import { Hono } from "hono";
import {
  OutboundInSchema,
  type OutboundIn,
  type OutboundPlatform,
} from "@noelle/contracts";
import { noelleDb } from "../lib/db.js";
import { sendPushover } from "../lib/pushover.js";
import { loadEnv } from "../env.js";
import { resolveLinkedInVoiceFloor } from "./linkedin-voice-policy.js";
import { OutboundBundleError, saveOutboundBundle, type OutboundApprovalReceipt } from "../lib/outbound-bundle-db.js";

// Both interns POST drafts to this one route, so the Pushover title's agent
// label MUST be keyed off the payload platform — otherwise a LinkedIn (Lyra)
// draft pages the operator as the "X Intern" and vice versa.
const INTERN_LABEL: Record<OutboundPlatform, string> = {
  x: "X Intern",
  linkedin: "LinkedIn Intern",
  reddit: "Reddit Intern",
};

/** Pushover title for a freshly-drafted bundle, platform-correct. */
export function draftPushoverTitle(args: {
  platform: OutboundPlatform;
  tierLabel: string;
  authorHandle: string;
}): string {
  return `🤖 ${INTERN_LABEL[args.platform]}: ${args.tierLabel} draft from @${args.authorHandle}`;
}

/**
 * Notification batching: with NOELLE_NOTIFY_BATCH=N, page the operator only on
 * every Nth drafted bundle (per agent) instead of every lead. N<=1 → every
 * bundle (back-compat). `bundleCount` is the running count for that agent.
 */
export function shouldNotifyBatch(bundleCount: number, batchSize: number): boolean {
  if (batchSize <= 1) return true;
  return bundleCount % batchSize === 0;
}

// Running drafted-bundle count per agent_instance_id, used to gate the batched
// Pushover. In-memory (single api-vm process); resets on restart — a missed tail
// of < NOELLE_NOTIFY_BATCH drafts is fine since they're visible in the inbox.
const draftBundleCounts = new Map<string, number>();

// Postgres jsonb rejects two byte patterns with "invalid input syntax for type
// json": a NUL byte (\u0000) and a LONE UTF-16 surrogate. The latter is the real
// one we hit — a fixed-length anchor snippet slice (or a truncated post) can cut
// an emoji's surrogate pair in half, leaving a lone \uD83D etc. Strip both from
// every string before we cast the payload to jsonb, recursing through arrays and
// objects (anchors, drafts). Without this a single split emoji fails the whole
// lead upsert and the draft is silently lost.
export function sanitizeForJsonb<T>(value: T): T {
  if (typeof value === "string") {
    return value
      .replaceAll("\u0000", "")
      // lone high surrogate (not followed by a low surrogate)
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
      // lone low surrogate (not preceded by a high surrogate)
      .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "") as T;
  }
  if (Array.isArray(value)) return value.map(sanitizeForJsonb) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeForJsonb(v);
    return out as T;
  }
  return value;
}

// POST /api/outbound — HMAC-signed lead, draft variants, and approval bundle.
// Storage commits one scoped transaction before notification. Exact retries
// preserve saved drafts and approval decisions.

const outbound = new Hono();

outbound.post("/api/outbound", async (c) => {
  const env = loadEnv();
  let payload: OutboundIn;
  try {
    const raw = await c.req.json();
    // Strip jsonb-hostile bytes (NUL, lone surrogates from emoji split by a
    // snippet slice) from every string before anything is cast to jsonb — one
    // bad byte otherwise fails the lead upsert and the whole draft is lost.
    payload = sanitizeForJsonb(OutboundInSchema.parse(raw));
  } catch (err) {
    return c.json(
      {
        error: "invalid_body",
        detail: err instanceof Error ? err.message : String(err),
      },
      400
    );
  }

  const requestedDraft = payload.humanReviewRequired === true || Boolean(payload.replyRequestKey);
  if ((payload.postKind === "relationship_dm" || requestedDraft) && !payload.owner) {
    return c.json({ error: "invalid_body", detail: "Requested drafts and Friendly DMs require an explicit owner." }, 400);
  }
  if (payload.postKind === "relationship_dm" && payload.autoSend) {
    return c.json({ error: "invalid_body", detail: "Friendly DMs require human review." }, 400);
  }
  let leadId: string;
  let owner: { org_id: string; agent_instance_id: string };
  let insertedApprovals: OutboundApprovalReceipt[];
  try {
    const saved = await saveOutboundBundle(noelleDb(), payload,
      payload.platform === "linkedin" ? resolveLinkedInVoiceFloor() : undefined);
    ({ leadId, owner, approvals: insertedApprovals } = saved);
  } catch (error) {
    if (error instanceof OutboundBundleError) return c.json({ error: error.code }, error.status);
    console.error("[outbound] bundle storage failed");
    return c.json({ error: "bundle_upsert_failed" }, 500);
  }

  // Legacy autoSend metadata grants no send permission. Queue ingestion does
  // not dispatch; the configured send owner enforces its consent and caps.

  // 5. Pushover — fire once per bundle, suppressed when quality gate failed.
  //    Prefer the empathetic approval as the deeplink target (canonical reply
  //    angle the UI surfaces first). Fall back to the first approval.
  const pendingApprovals = insertedApprovals.filter((approval) => approval.status === "pending");
  const empathetic =
    pendingApprovals.find((a) =>
      payload.drafts.some(
        (d) => d.id === a.draft_id && d.angle === "empathetic"
      )
    ) ?? pendingApprovals[0] ?? insertedApprovals[0]!;

  // Batch notifications for committed pending approvals per instance.
  const gatePasses = payload.qualityGatePassed !== false && pendingApprovals.length > 0;
  let bundleCount = 0;
  if (gatePasses) {
    bundleCount = (draftBundleCounts.get(owner.agent_instance_id) ?? 0) + 1;
    draftBundleCounts.set(owner.agent_instance_id, bundleCount);
  }
  const shouldPush = gatePasses && shouldNotifyBatch(bundleCount, env.NOELLE_NOTIFY_BATCH);
  let pushoverFired = false;
  if (shouldPush && env.NOELLE_APP_BASE_URL) {
    const url = `${env.NOELLE_APP_BASE_URL.replace(/\/$/, "")}/approvals/${empathetic.id}`;
    const tierLabel = payload.tier ?? "T?";
    const excerpt = payload.originalPostText
      .slice(0, 140)
      .replace(/\s+/g, " ")
      .trim();
    // When batching, lead with how many new drafts this ping represents.
    const batchPrefix =
      env.NOELLE_NOTIFY_BATCH > 1 ? `${env.NOELLE_NOTIFY_BATCH} new drafts · ` : "";
    const result = await sendPushover({
      title: draftPushoverTitle({
        platform: payload.platform,
        tierLabel,
        authorHandle: payload.authorHandle,
      }),
      message: `${batchPrefix}${excerpt}${payload.originalPostText.length > 140 ? "…" : ""}`,
      url,
      urlTitle: "Review in Noelle",
      // Normal priority for all tiers — drafts are review-when-convenient, not
      // urgent. (Was priority 1 / red for T1 watchlist leads.)
      priority: 0,
    });
    pushoverFired = result.ok;
    if (!result.ok) {
      console.warn("[outbound] pushover skipped", result.reason);
    }
  }

  return c.json(
    {
      id: empathetic.id,
      approval_id: empathetic.id,
      approval_ids: insertedApprovals.map((a) => a.id),
      draft_ids: insertedApprovals.map((a) => a.draft_id),
      lead_id: leadId,
      pushover_fired: pushoverFired,
    },
    200
  );
});

export { outbound };

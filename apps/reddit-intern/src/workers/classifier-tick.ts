import type { Sql } from "postgres";
import { assertWithinCap, BudgetExceededError, type Bus, type CapAdapters } from "@noelle/runtime";
import type { Logger } from "../lib/logger.js";
import type { LeadRow } from "../lib/leads-db.js";
import type { Classifier } from "../lib/classifier-engine.js";
import { markLeadClassified } from "../lib/leads-db.js";
import { detectLanguage } from "../lib/language.js";

/** Per-tick estimate for the classifier cap gate: one batch of cheap calls
 *  (~1¢ each, rounded up). Backpressure, not accounting — each call's real cost
 *  is recorded after it completes. Mirrors x-intern. */
export const CLASSIFIER_TICK_ESTIMATE_CENTS = 10;

/**
 * Cap gate for one classifier tick. Returns the `BudgetExceededError` when the
 * org/instance is at its cap on the `classifier` bucket (the caller skips the
 * tick), or `null` to proceed. Non-budget errors propagate so the run is
 * recorded as failed rather than silently skipped.
 *
 * Only meaningful on the Noelle-billed path — a BYO-key org pays Google
 * directly, so the worker does not gate it on the Noelle budget.
 * claude-cli is likewise never gated: it runs on the flat-rate local Claude
 * subscription and records cents=0, so blocking it protects no money — while
 * paid spend left over from a claude-cli outage window (when calls billed to
 * Bedrock) would otherwise freeze $0 classification for the rest of the
 * month. Mirrors callAgentModel's skipCap.
 */
export async function classifierBudgetBlock(
  adapters: CapAdapters,
  args: {
    orgId: string;
    instanceId: string;
    /** Engine the Noelle-billed path bills under (recordEngine). */
    engine?: "vertex" | "bedrock" | "claude-cli";
  },
): Promise<BudgetExceededError | null> {
  if (args.engine === "claude-cli") return null;
  try {
    await assertWithinCap(
      {
        bucket: "classifier",
        orgId: args.orgId,
        instanceId: args.instanceId,
        estimatedCents: CLASSIFIER_TICK_ESTIMATE_CENTS,
      },
      adapters,
    );
    return null;
  } catch (err) {
    if (err instanceof BudgetExceededError) return err;
    throw err;
  }
}

/**
 * Classify a single claimed Reddit lead.
 *
 * English-only gate (always on): a post detected as non-English is skipped
 * (status 'skipped', reply_kind 'skip', skip_reason='non-english') before any
 * LLM call, so it never reaches the drafter. The detector is lenient on short /
 * emoji / ambiguous text (those pass through as English).
 *
 * Otherwise scores the post with the quality engine, then advances the lead:
 *   - reply_kind 'substantial' | 'light' → status 'classified' (drafter claims).
 *   - reply_kind 'skip'                   → status 'skipped'   (terminal).
 *
 * The engine fails open to substantial/T3 (q=null) on any backend error so a
 * high-signal post is never silently lost when scoring is down. Admission failures stop work.
 * Backend admission and receipts are owned by the worker's shared metered backend.
 */
export async function classifyOneLead(deps: {
  sql: Sql;
  classifier: Pick<Classifier, "classify">;
  notifier: { notify: (a: { orgId: string; title: string; message: string }) => Promise<unknown> };
  inst: { id: string; org_id: string; notify_low_confidence?: boolean | null };
  lead: LeadRow;
  log: Pick<Logger, "warn">;
  /** Shared-memory bus (optional). Emits a `lead.classified` event per lead. */
  bus?: Bus;
}): Promise<void> {
  const { sql, classifier, notifier, inst, lead, log, bus } = deps;

  const payload = lead.payload as {
    title?: string;
    text?: string;
    subreddit?: string | null;
  };
  // A Reddit post is title + self-text. Link posts have an empty body, so the
  // title carries the signal — combine both so the classifier always has content.
  const title = (payload.title ?? "").trim();
  const body = (payload.text ?? "").trim();
  const postText = title && body ? `${title}\n\n${body}` : title || body;

  // English-only gate (always on) — runs BEFORE any LLM call. The operator only
  // wants English leads; a non-English post (e.g. a French connection's update)
  // would otherwise get a non-English draft. We skip it here so it never reaches
  // the drafter. Applies to every lead regardless of priority (watch-lane
  // connections included) — non-English is dropped even for watched people. The
  // priority clamp below only protects the QUALITY skip, not the language gate.
  // (Watch-lane leads are priority=true; see the clamp.) The detector
  // is lenient on short / emoji / ambiguous text (those pass through as English).
  // Non-English is skipped regardless of priority (the operator only wants
  // English leads) — the priority clamp below only protects the QUALITY skip.
  const lang = detectLanguage(postText);
  if (lang.isNonEnglish) {
    await markLeadClassified(sql, {
      leadId: lead.id,
      replyKind: "skip",
      score: null,
      tier: null,
      classifierMeta: {
        skip_reason: "non-english",
        reply_kind: "skip",
        reason: `non-english (${lang.reason})`,
        language: { reason: lang.reason, signals: lang.signals },
      },
    });
    await bus?.emit({
      topic: "lead.classified",
      worker: "classifier",
      summary: "skipped non-english",
      payload: { lead_id: lead.id, reply_kind: "skip", tier: null, skip_reason: "non-english" },
      correlationId: lead.id,
    });
    return;
  }

  const cls = await classifier.classify({
    postText,
    authorName: lead.author_handle,
    // Reddit has no headline; surface the subreddit as the author context line.
    authorHeadline: payload.subreddit ? `posted in r/${payload.subreddit}` : null,
  });

  // Priority clamp: a lead from a person the operator hand-picked — a watched
  // CONNECTION (watch lane, priority=true) or an ICP-vetted profile-first author
  // — is never hard-skipped. The PERSON is the gate, not the post, so a 'skip'
  // verdict on their post is clamped to 'light' (a short supportive comment).
  // Substantial/tier verdicts pass through unchanged. Only the keyword/search
  // lane (priority=false) keeps the full skip behaviour — that's where junk is.
  const clamped = lead.priority && cls.reply_kind === "skip";
  const replyKind = clamped ? "light" : cls.reply_kind;
  const tier = clamped ? null : cls.tier;


  // Normalise the 0-100 q into a 0-1 score before storing — the shared approval
  // UI does Math.round(score * 100), so a raw q=78 rendered as "7800/100". Match
  // the X intern, which stores 0-1. null when unscored (NULL, not a fake 0).
  await markLeadClassified(sql, {
    leadId: lead.id,
    replyKind,
    score: cls.q == null ? null : cls.q / 100,
    tier,
    // Persist the engagement-bait verdict so the drafter can ignore an inflated
    // comment count when deciding Opus. Defaults false on every fail-open path.
    commentBait: cls.comment_bait,
    classifierMeta: {
      ...(cls.raw as Record<string, unknown>),
      q: cls.q,
      reply_kind: replyKind,
      tier,
      comment_bait: cls.comment_bait,
      reason: clamped ? `${cls.reason} (priority-clamped skip→light)` : cls.reason,
      // The model's raw verdict before the priority clamp, for observability.
      ...(clamped ? { raw_reply_kind: cls.reply_kind, priority_clamped: true } : {}),
    },
  });
  await bus?.emit({
    topic: "lead.classified",
    worker: "classifier",
    summary: `classified ${tier ?? replyKind}`,
    payload: { lead_id: lead.id, reply_kind: replyKind, tier, score: cls.q },
    correlationId: lead.id,
  });

  // notify_low_confidence: ping when the classifier decided to SKIP a lead, so
  // the operator can eyeball borderline drops. Best-effort; notifier.notify()
  // returns status='no_channel' rather than throwing when no keys exist.
  if (inst.notify_low_confidence && replyKind === "skip") {
    await notifier
      .notify({
        orgId: inst.org_id,
        title: `Skipped lead · ${lead.author_handle}`,
        message: `Classifier skipped a post (q=${cls.q ?? "—"}).\n${cls.reason}`,
      })
      .catch((err) => {
        log.warn(
          { leadId: lead.id, err: (err as Error).message },
          "notify low-confidence failed",
        );
      });
  }
}

"use client";

import * as React from "react";
import styles from "./speedrun.module.css";
import { AppLink as Link } from "@/components/nav/AppLink";
import { SpeedrunRow, type SpeedrunDraft } from "./SpeedrunRow";
import { markSentManual, sendDraft, skipDraft } from "@/app/app/[orgSlug]/approvals/actions";

/**
 * Flat copy-paste list of pending drafts.
 *
 * Ported from screens.jsx `SpeedrunApprovals`: progress bar at the top, one
 * card per draft, the "pick an angle, copy, paste into X, mark sent" rhythm.
 *
 * Mark sent is now PERSISTED. Tapping it fires the `markSentManual` server
 * action, which flips the approval to 'sent' and skips the lead's other
 * angles WITHOUT re-posting to X (the human already posted by hand). The
 * update is optimistic: the row clears immediately and, on the next
 * `router.refresh()` (AutoRefresh, 30s), it's gone from the pending query for
 * good. If the action fails, the row comes back with an inline error to retry.
 *
 * It is one-way: once the approval is 'sent' (siblings skipped) there's no
 * clean client-side undo, so there's no "undo" toggle here anymore — review
 * what you've sent via the Status filter on the inbox.
 */

interface Props {
  drafts: SpeedrunDraft[];
  /** Base path for "Full review →" links, e.g. `/app/<orgSlug>/approvals`. */
  basePath: string;
  /** Active queue filters as a URL suffix, appended to "Full review" links. */
  filterQuery?: string;
  /** Org slug — scopes the markSentManual server action + revalidation. */
  orgSlug: string;
  /** Platform. "linkedin"/"reddit" are draft-only (Copy + Mark sent; no red Send). */
  platform?: "x" | "linkedin" | "reddit";
  /**
   * True when the list is empty ONLY because the active filters hid a non-empty
   * backlog — drives a "no matches / clear filters" empty state instead of the
   * "intern hasn't drafted anything" copy.
   */
  filteredEmpty?: boolean;
  /** Where "Clear filters" navigates — the default unfiltered pending view. */
  clearHref?: string;
}

function friendlyMarkSentError(code: string, fallback: string): string {
  switch (code) {
    case "rate_limited":
      return "Going too fast — wait a moment and retry";
    case "already_actioned":
      return "Already actioned elsewhere — refresh";
    case "not_found":
      return "This approval no longer exists — refresh";
    default:
      return fallback || "Couldn't mark sent — retry";
  }
}

function actionApprovalId(draft: SpeedrunDraft | undefined, angleId?: string): string | undefined {
  if (!draft) return undefined;
  if (draft.kind === "dm") return draft.dmApprovalId ?? draft.id;
  return draft.angles.find((angle) => angle.id === angleId)?.approvalId
    ?? draft.angles[0]?.approvalId;
}

export function SpeedrunInbox({
  drafts,
  basePath,
  filterQuery = "",
  orgSlug,
  platform = "x",
  filteredEmpty = false,
  clearHref = "",
}: Props) {
  // Human-readable destination for the "paste into <platform>" copy.
  const platformName =
    platform === "linkedin" ? "LinkedIn" : platform === "reddit" ? "Reddit" : "X";
  const [picks, setPicks] = React.useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const d of drafts) {
      const first = d.angles[0];
      if (first) m[d.id] = first.id;
    }
    return m;
  });
  // Optimistically-sent approval ids. Persisted server-side; reconciled by
  // the next router.refresh (the row leaves the pending query entirely).
  const [sent, setSent] = React.useState<Set<string>>(() => new Set());
  // Optimistically-skipped lead ids. Also persisted (status → 'skipped') and
  // reconciled on refresh; kept apart from `sent` so the progress bar / "Show
  // sent" toggle count only true sends, while skips just clear the row.
  const [skipped, setSkipped] = React.useState<Set<string>>(() => new Set());
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [hideSent, setHideSent] = React.useState(true);
  const [, startTransition] = React.useTransition();

  const total = drafts.length;
  const sentCount = drafts.filter((d) => sent.has(d.id)).length;
  const skippedCount = drafts.filter((d) => skipped.has(d.id)).length;
  // "Remaining" = not yet actioned either way; the bar fills on send AND skip
  // (both clear the card from the queue).
  const clearedCount = sentCount + skippedCount;
  const remaining = total - clearedCount;
  const progress = total === 0 ? 0 : (clearedCount / total) * 100;

  const markSent = (id: string, explicitAngleId?: string) => {
    // `id` is the LEAD id now; mark sent on the PICKED angle's approval (each
    // angle is its own approval row). The send handler skips the lead's other
    // reply angles, leaving the DM. The per-angle open link passes its angle id
    // explicitly because `setPicks` hasn't flushed yet when it fires.
    const d = drafts.find((x) => x.id === id);
    const angleId = explicitAngleId ?? picks[id] ?? d?.angles[0]?.id;
    const approvalId = actionApprovalId(d, angleId);
    if (!approvalId) return;
    // Optimistic: clear the row now, drop any prior error.
    setSent((prev) => new Set(prev).add(id));
    setErrors((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    startTransition(async () => {
      const res = await markSentManual({ orgSlug, approvalId });
      if (!res.ok) {
        // Roll back the optimistic clear and surface the error to retry.
        setSent((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setErrors((prev) => ({
          ...prev,
          [id]: friendlyMarkSentError(res.error.code, res.error.message),
        }));
      }
    });
  };

  // Red "Send": the agent posts the picked reply to X NOW (real tweet via the
  // org's stored cookies), then clears the row. Mirrors markSent but uses the
  // /send path instead of recording a manual hand-off.
  const sendNow = (id: string) => {
    const d = drafts.find((x) => x.id === id);
    if (!d || d.kind === "dm") return;
    const angleId = picks[id] ?? d?.angles[0]?.id;
    const picked = d?.angles.find((a) => a.id === angleId) ?? d?.angles[0];
    const approvalId = picked?.approvalId;
    if (!approvalId || !picked) return;
    setSent((prev) => new Set(prev).add(id));
    setErrors((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    startTransition(async () => {
      const res = await sendDraft({
        orgSlug,
        approvalId,
        originalBody: picked.text,
        body: picked.text,
      });
      if (!res.ok) {
        setSent((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setErrors((prev) => ({
          ...prev,
          [id]: res.error.message || "Couldn't post to X — retry",
        }));
      }
    });
  };

  // Skip the whole lead — flips its pending reply angles to 'skipped' (the
  // /skip route skips siblings server-side, so targeting the picked angle's
  // approval clears the lead). One-click, like the Review inbox's ✕; optimistic
  // with rollback on error. Works for both X and LinkedIn (platform-agnostic).
  const skip = (id: string) => {
    const d = drafts.find((x) => x.id === id);
    const angleId = picks[id] ?? d?.angles[0]?.id;
    const approvalId = actionApprovalId(d, angleId);
    if (!approvalId) return;
    setSkipped((prev) => new Set(prev).add(id));
    setErrors((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    startTransition(async () => {
      const res = await skipDraft({ orgSlug, approvalId });
      if (!res.ok) {
        setSkipped((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setErrors((prev) => ({
          ...prev,
          [id]: res.error.message || "Couldn't skip — retry",
        }));
      }
    });
  };

  if (total === 0) {
    return filteredEmpty ? (
      <div className={styles.empty}>
        No drafts match these filters.{" "}
        <Link href={clearHref} style={{ color: "var(--accent)" }}>
          Clear filters
        </Link>{" "}
        to speed through the rest of the queue.
      </div>
    ) : (
      <div className={styles.empty}>
        Nothing to speed through right now. New drafts land here as the
        intern produces them.
      </div>
    );
  }

  // Skipped cards always leave the list (no "show skipped" here — review them
  // via the Status → Skipped filter). Sent cards hide unless "Show sent".
  const visible = drafts.filter(
    (d) => !skipped.has(d.id) && (hideSent ? !sent.has(d.id) : true),
  );

  return (
    <div className={styles.inbox}>
      <div className={styles.progress}
      >
        <div className={styles.progressLabel}
        >
          {remaining} of {total} remaining
        </div>
        <div className="bar-track" style={{ flex: 1, height: 6 }}>
          <div className="bar-fill acc" style={{ width: `${progress}%` }} />
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setHideSent((v) => !v)}
          disabled={sentCount === 0}
        >
          {hideSent ? `Show sent (${sentCount})` : "Hide sent"}
        </button>
      </div>

      <div className={styles.list}>
        {visible.map((d, i) => (
          <SpeedrunRow
            key={d.id}
            d={d}
            n={i + 1}
            pickedId={picks[d.id] ?? null}
            onPick={(angleId) =>
              setPicks((p) => ({ ...p, [d.id]: angleId }))
            }
            isSent={sent.has(d.id)}
            error={errors[d.id] ?? null}
            onMarkSent={(angleId) => markSent(d.id, angleId)}
            onSend={() => sendNow(d.id)}
            onSkip={() => skip(d.id)}
            fullReviewHref={`${basePath}/${d.id}${filterQuery}`}
            platform={platform}
            orgSlug={orgSlug}
          />
        ))}
      </div>

      <div className={styles.guide}
      >
        <span className="serif" style={{ fontSize: 18, color: "var(--ink)" }}>
          How this works
        </span>
        <span>
          Speedrun mode skips the full review screen. The intern drafts three
          angles — pick one, hit{" "}
          <b style={{ color: "var(--ink)", fontFamily: "var(--mono)" }}>Copy</b>,
          paste into {platformName}, then{" "}
          <b style={{ color: "var(--ink)", fontFamily: "var(--mono)" }}>
            Mark sent
          </b>
          . That records the reply as sent and clears it from the queue (it
          does <i>not</i> re-post to {platformName}{" "}
          — you already did). Review past sends with the{" "}
          <b style={{ color: "var(--ink)" }}>Status</b> filter.
        </span>
      </div>
    </div>
  );
}

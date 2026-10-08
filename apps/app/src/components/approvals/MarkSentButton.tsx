"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  markSentManual,
  unmarkSentManual,
  type MarkSentManualResult,
} from "@/app/app/[orgSlug]/approvals/actions";

/** Seconds the "Undo" affordance stays before the row auto-advances. */
const UNDO_WINDOW_SECONDS = 8;

/**
 * Explicit manual-send acknowledgment for the LinkedIn review surface.
 * The operator sends the draft on LinkedIn, then clicks this to record it.
 * It hits the platform-agnostic
 * `markSentManual` server action (POST /api/drafts/:id/mark-sent), which flips
 * the approval to 'sent' and auto-skips sibling angles WITHOUT posting anything.
 */
interface Props {
  orgSlug: string;
  approvalId: string;
  /** Where to go after a successful mark-sent (next pending, or the queue). */
  nextHref?: string | null;
  listHref: string;
  label?: string;
  /**
   * Optional async hook run BEFORE the mark-sent POST. The LinkedIn panel uses
   * it to persist an operator edit (saveDraftEdit → edited_body) first, so the
   * draft-only "Mark sent" still captures the learning signal. A thrown/false
   * result aborts the mark-sent so we never record a send whose edit failed to
   * save. No-op for callers that don't pass it.
   */
  beforeMarkSent?: () => Promise<boolean | void>;
}

export function MarkSentButton({
  orgSlug,
  approvalId,
  nextHref,
  listHref,
  label = "Mark sent",
  beforeMarkSent,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [result, setResult] = React.useState<MarkSentManualResult | null>(null);
  // Countdown (seconds) for the transient Undo window; null = not counting.
  const [countdown, setCountdown] = React.useState<number | null>(null);
  // True once Undo has reverted the send — we stay on the row and stop advancing.
  const [reverted, setReverted] = React.useState(false);
  const done = (result?.ok ?? false) && !reverted;

  // After a successful mark-sent, hold for an UNDO_WINDOW so the operator can
  // reverse an accidental send, ticking a visible countdown. When it elapses we
  // refresh (row leaves the pending queue) and advance to the next pending lead.
  // Undo (below) clears this by flipping `reverted`.
  React.useEffect(() => {
    if (!done) {
      setCountdown(null);
      return;
    }
    setCountdown(UNDO_WINDOW_SECONDS);
    const tick = setInterval(() => {
      setCountdown((s) => (s != null && s > 1 ? s - 1 : s));
    }, 1000);
    const t = setTimeout(() => {
      router.refresh();
      router.push(nextHref ?? listHref);
    }, UNDO_WINDOW_SECONDS * 1000);
    return () => {
      clearInterval(tick);
      clearTimeout(t);
    };
  }, [done, router, nextHref, listHref]);

  const onClick = () => {
    if (pending || done) return;
    setResult(null);
    setReverted(false);
    startTransition(async () => {
      // Persist any edit (edited_body) before recording the send. If the edit
      // save explicitly fails (returns false), abort so we don't mark a draft
      // sent whose learning signal didn't land.
      if (beforeMarkSent) {
        const ok = await beforeMarkSent();
        if (ok === false) return;
      }
      const res = await markSentManual({ orgSlug, approvalId });
      setResult(res);
    });
  };

  // Undo within the window: reverse the manual send (approval back to pending,
  // siblings restored) and stay put. Flipping `reverted` cancels the auto-advance.
  const onUndo = () => {
    setReverted(true); // cancels the pending auto-advance immediately
    startTransition(async () => {
      const res = await unmarkSentManual({ orgSlug, approvalId });
      if (res.ok) {
        setResult(null);
        router.refresh();
      } else {
        // Revert failed — restore the sent state + its error so the operator sees it.
        setReverted(false);
        setResult({ ok: false, error: res.error });
      }
    });
  };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 10,
      }}
    >
      {result && !result.ok ? (
        <span
          className="tag"
          style={{
            color: "var(--danger)",
            fontSize: 11.5,
            whiteSpace: "normal",
            maxWidth: "100%",
            wordBreak: "break-word",
          }}
        >
          {result.error.message}
        </span>
      ) : null}
      {done ? (
        <>
          <span className="tag tag-ok">Marked sent ✓</span>
          <button
            type="button"
            className="btn btn-xs"
            onClick={onUndo}
            disabled={pending}
            title="Undo — put this draft back in the queue and restore its other angles"
          >
            {pending ? "Undoing…" : countdown != null ? `Undo (${countdown})` : "Undo"}
          </button>
        </>
      ) : null}
      <button
        type="button"
        className="btn"
        onClick={onClick}
        disabled={pending || done}
        title="Record a reply you posted manually on LinkedIn as sent. Actor-posted replies are recorded automatically."
      >
        {pending ? "Marking…" : label}
      </button>
    </span>
  );
}

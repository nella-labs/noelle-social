"use client";

import * as React from "react";
import styles from "./review-detail.module.css";
import { useRouter } from "next/navigation";
import { useCopy } from "@/lib/use-copy";
import { buildXReplyUrl } from "@/lib/x-reply-url";
import {
  sendDraft,
  skipDraft,
  markSentManual,
  saveDraftEdit,
  unskipDraft,
  unmarkSentManual,
  type SendDraftResult,
  type SkipDraftResult,
  type MarkSentManualResult,
} from "@/app/app/[orgSlug]/approvals/actions";

// How long the "Undo" stays offered after a reversible action (skip / manual
// mark-sent) before we auto-advance. Mirrors the LinkedIn MarkSentButton window.
// A real X Send → posts a live tweet and is NOT reversible — no undo there.
const UNDO_WINDOW_SECONDS = 8;

/**
 * Client-side angle picker + Approve/Skip actions for the new Approvals
 * detail design (`.angle-stack` + `.angle.selected`). Wraps the existing
 * server actions in `actions.ts` — DO NOT duplicate their wire logic here.
 *
 * The 3 angles come from the drafter via the `drafts.payload`
 * jsonb. Two shapes are tolerated (`payload.angles.<kind>.body` bundled, or a
 * single `payload.body` + `payload.angle`); the server page extracts them
 * into the `AngleOption[]` we accept here so this component stays UI-only.
 */

export interface AngleOption {
  /** Stable identifier — used by `selected` state. Usually "empathetic" / "technical" / "contrarian". */
  id: string;
  /** Capitalized label shown in the angle header ("Empathetic"). */
  kind: string;
  /** Body text the operator will send. */
  text: string;
  /** 0..1 quality score from the classifier; null if not mirrored yet. */
  quality?: number | null;
  /**
   * The approval row backing THIS angle. Each reply angle is its own approval
   * (separate draft), so send/skip must target the selected angle's approval,
   * not a single page-level one. Falls back to the `approvalId` prop when
   * absent (legacy single-draft callers).
   */
  approvalId?: string;
  /**
   * Account-Feeder voice blend that shaped this draft (Lyra only) — drives the
   * "Style: …%" badge. Null/absent ⇒ base voice only (or an X angle, which has
   * no fed-style concept).
   */
  styleSource?: { blend: Array<{ handle: string; weight: number }> } | null;
}

interface Props {
  orgSlug: string;
  approvalId: string;
  angles: AngleOption[];
  /**
   * Detail URL of the next pending lead, for auto-advance after an action.
   * Null when this is the last pending lead (we fall back to the queue).
   */
  nextHref?: string | null;
  /**
   * Filtered queue URL to return to when there's no next lead (last in the
   * queue), so the operator's active filter survives. Defaults to the bare
   * queue when no filter is active.
   */
  listHref?: string;
  /** The lead's tweet id — used to open the X reply composer pre-filled. */
  postId?: string | null;
}

/**
 * Translate the api-vm error code returned by POST /api/drafts/:id/send
 * into one-line copy the founder can act on. Falls back to the raw upstream
 * message when the code is something we haven't mapped (e.g. a Hono validation
 * error code that shouldn't normally reach this path).
 */
function friendlySendError(code: string, fallback: string): string {
  switch (code) {
    case "x_auth_failed":
      return "X cookies expired — reconnect under /connections";
    case "x_rate_limited":
      return "X is rate-limiting — wait a minute and retry";
    case "x_cookies_missing":
      return "No X account connected for this org yet";
    case "x_post_failed":
      return `X refused the post: ${fallback}`;
    case "missing_in_reply_to":
      return "Original tweet wasn't recorded; can't post a reply";
    case "db_write_failed_after_post":
      return "Posted on X but our records didn't sync — check /approvals/sent";
    default:
      return fallback;
  }
}

export function DraftReviewPanel({
  orgSlug,
  approvalId,
  angles,
  nextHref,
  listHref,
  postId,
}: Props) {
  const router = useRouter();
  const { copiedKey, copy } = useCopy();
  const [selectedId, setSelectedId] = React.useState<string>(
    angles[0]?.id ?? "",
  );
  const selected = angles.find((a) => a.id === selectedId) ?? angles[0];
  // Each angle is its own approval row; act on the selected angle's approval,
  // falling back to the page-level prop for legacy single-draft callers.
  const targetApprovalId = selected?.approvalId ?? approvalId;

  // The editable body. Seeded from the selected angle's text; the operator can
  // tweak it before sending. We send THIS (`draft`) and pass the original angle
  // text as `originalBody`, so when they differ the `edited` flag fires and the
  // api-vm persists payload.edited_body — the single best learning signal.
  const [draft, setDraft] = React.useState<string>(selected?.text ?? "");
  // Re-seed the textarea when the selected angle changes (the operator picked a
  // different angle), but NOT on every render — only when the source text moves.
  const seededFor = React.useRef<string>(selected?.text ?? "");
  React.useEffect(() => {
    const next = selected?.text ?? "";
    if (seededFor.current !== next) {
      seededFor.current = next;
      setDraft(next);
    }
  }, [selected?.text]);
  const edited = !!selected && draft !== selected.text;

  // Pick an angle AND copy it in one gesture: the reply you choose for
  // "Approve & send" is the same text that lands on your clipboard to paste.
  // Re-seeds the editable textarea (handled by the effect above keyed on the
  // selected angle's text).
  const pickAngle = (a: AngleOption) => {
    setSelectedId(a.id);
    copy(a.text, a.id);
  };

  const [pending, startTransition] = React.useTransition();
  const [sendResult, setSendResult] = React.useState<SendDraftResult | null>(
    null,
  );
  const [skipResult, setSkipResult] = React.useState<SkipDraftResult | null>(
    null,
  );
  const [markSentResult, setMarkSentResult] =
    React.useState<MarkSentManualResult | null>(null);
  // Optional link to the reply you posted on X by hand — captured so the
  // dashboard can show a live "view reply" for the mark-sent path.
  const [manualUrl, setManualUrl] = React.useState("");

  const success = sendResult?.ok || skipResult?.ok || markSentResult?.ok;

  // Undo: a SKIP or a manual MARK-SENT is reversible (unskip / unmark-sent), so
  // we hold the page on an "Undo (n)" countdown before auto-advancing. A real
  // Send → posts a live tweet and can't be recalled, so it never offers undo.
  const undoable = !!(skipResult?.ok || markSentResult?.ok);
  const [undone, setUndone] = React.useState(false);
  const [undoLeft, setUndoLeft] = React.useState(UNDO_WINDOW_SECONDS);
  const canUndo = undoable && !undone;

  // Auto-return to the inbox after success. A reversible action holds for the
  // full undo window (ticking down a visible counter); an irreversible send
  // holds just long enough to read the "view on X" link. After an undo we cancel
  // the advance entirely and stay on the lead.
  React.useEffect(() => {
    if (!success || undone) return;
    if (canUndo) {
      if (undoLeft <= 0) {
        router.refresh();
        router.push(nextHref ?? listHref ?? `/app/${orgSlug}/approvals`);
        return;
      }
      const t = setTimeout(() => setUndoLeft((n) => n - 1), 1000);
      return () => clearTimeout(t);
    }
    const sentUrl = sendResult?.ok ? sendResult.sentUrl : undefined;
    const dwellMs = sentUrl ? 2400 : 1200;
    const t = setTimeout(() => {
      router.refresh();
      // Advance to the next pending lead so the operator keeps reviewing in
      // place; only when this was the last one do we land back on the queue —
      // preserving the active filter (listHref) so they don't lose it.
      router.push(nextHref ?? listHref ?? `/app/${orgSlug}/approvals`);
    }, dwellMs);
    return () => clearTimeout(t);
  }, [success, canUndo, undoLeft, undone, sendResult, router, orgSlug, nextHref, listHref]);

  // Reverse the just-taken action and return the lead to the actionable queue.
  // Resets the result state so the picker re-enables; router.refresh() re-fetches
  // the server component (the restored pending angles reappear).
  const onUndo = () => {
    startTransition(async () => {
      const res = markSentResult?.ok
        ? await unmarkSentManual({ orgSlug, approvalId: targetApprovalId })
        : await unskipDraft({ orgSlug, approvalId: targetApprovalId });
      if (res.ok) {
        setUndone(true);
        setSkipResult(null);
        setMarkSentResult(null);
        router.refresh();
      }
    });
  };

  const onApprove = () => {
    if (!selected || pending) return;
    const outgoing = draft.trim() ? draft : selected.text;
    setSendResult(null);
    startTransition(async () => {
      const res = await sendDraft({
        orgSlug,
        approvalId: targetApprovalId,
        // originalBody = the angle the drafter produced; body = what's in the
        // textarea. When they differ, `edited` fires and edited_body persists.
        originalBody: selected.text,
        body: outgoing,
      });
      setSendResult(res);
    });
  };

  const onSkip = () => {
    if (pending) return;
    setSkipResult(null);
    startTransition(async () => {
      const res = await skipDraft({ orgSlug, approvalId: targetApprovalId, reason: "skipped" });
      setSkipResult(res);
    });
  };

  // "I already posted this on X by hand" — records the approval as sent
  // without api-vm re-posting. Also the escape hatch when Approve & send
  // fails (e.g. missing_in_reply_to on a lead with no real tweet anchor).
  // /mark-sent carries no body, so if the operator edited the reply before
  // posting it by hand, persist that edit first (edited_body) so the manual
  // path still yields the learning signal.
  const onMarkSent = () => {
    if (pending) return;
    setMarkSentResult(null);
    startTransition(async () => {
      if (edited && selected) {
        const saved = await saveDraftEdit({ orgSlug, approvalId: targetApprovalId, body: draft });
        if (!saved.ok) {
          setMarkSentResult(saved);
          return;
        }
      }
      const res = await markSentManual({
        orgSlug,
        approvalId: targetApprovalId,
        tweetUrl: manualUrl.trim() || undefined,
      });
      setMarkSentResult(res);
    });
  };

  if (angles.length === 0) {
    return (
      <div className="card">
        <div className="eyebrow">No angles available</div>
        <div
          style={{
            marginTop: 10,
            fontSize: 13,
            color: "var(--ink-muted)",
            lineHeight: 1.5,
          }}
        >
          The drafter hasn&rsquo;t produced any angles for this lead yet, or
          the payload didn&rsquo;t sync cleanly.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className="eyebrow" style={{ marginBottom: 12 }}>
        Reply options · pick one
      </div>
      <div className="angle-stack">
        {angles.map((a, i) => {
          const isSelected = a.id === selectedId;
          return (
            <button
              key={a.id}
              type="button"
              className={`angle${isSelected ? " selected" : ""}`}
              onClick={() => pickAngle(a)}
              disabled={pending || !!success}
              title="Click to copy this reply (and pick it)"
            >
              <h4>
                <span className="num">0{i + 1}</span>
                <span>{a.kind}</span>
                {a.quality != null ? (
                  <span style={{ marginLeft: "auto", color: "var(--ink-soft)" }}>
                    quality · {(a.quality * 100).toFixed(0)}
                  </span>
                ) : null}
              </h4>
              <div className="text">{a.text}</div>
              <div className="angle-foot">
                <span>{a.text.length} chars</span>
                <span>·</span>
                <span
                  style={{
                    marginLeft: "auto",
                    color: copiedKey === a.id ? "var(--ok)" : "var(--ink-soft)",
                  }}
                >
                  {copiedKey === a.id ? "Copied ✓" : "click to copy"}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Editable reply. Seeded from the picked angle; tweak it before sending.
          What's here is exactly what gets posted — and when it differs from the
          angle text, the edit is persisted as the learning signal (edited_body). */}
      <div style={{ marginTop: 18 }}>
        <div
          className="eyebrow"
          style={{
            marginBottom: 8,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span>Your reply · edit before sending</span>
          {edited ? (
            <span className="tag" style={{ color: "var(--accent)", fontSize: 10.5 }}>
              edited
            </span>
          ) : null}
          <span style={{ marginLeft: "auto", color: "var(--ink-soft)", fontSize: 11 }}>
            {draft.length} chars
          </span>
        </div>
        <textarea
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={pending || !!success}
          rows={4}
          spellCheck
          aria-label="Editable reply body"
          placeholder="Edit the reply before you send it…"
          style={{
            width: "100%",
            minHeight: 96,
            resize: "vertical",
            fontSize: 14,
            lineHeight: 1.5,
            fontFamily: "inherit",
          }}
        />
        <div
          style={{
            marginTop: 6,
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => copy(draft, "__edited__")}
            disabled={!draft.trim()}
            title="Copy the edited reply to your clipboard"
          >
            {copiedKey === "__edited__" ? "Copied ✓" : "Copy edited"}
          </button>
          {edited ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setDraft(selected?.text ?? "")}
              disabled={pending || !!success}
              title="Discard your edit and restore the drafter's original angle"
            >
              Reset to draft
            </button>
          ) : null}
        </div>
      </div>

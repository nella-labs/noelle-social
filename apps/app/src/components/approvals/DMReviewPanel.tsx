"use client";

import * as React from "react";
import styles from "./review-detail.module.css";
import { useRouter } from "next/navigation";
import { CopyButton } from "./CopyButton";
import { buildXDmUrl } from "@/lib/x-dm-url";
import {
  sendDraft,
  skipDraft,
  parkDraft,
  type SendDraftResult,
  type SkipDraftResult,
  type ParkDraftResult,
} from "@/app/app/[orgSlug]/approvals/actions";

/**
 * Review surface for a `kind='dm'` draft.
 *
 * A DM is manual-send: the X intern can't (and shouldn't) auto-DM strangers,
 * so the founder copies the message, sends it on X by hand, then clicks
 * "Mark as sent". That click hits the SAME `sendDraft` action used for
 * replies — the api-vm `/api/drafts/:id/send` route branches on the draft
 * kind and, for a DM, just flips the approval to `sent` WITHOUT posting
 * anything to X. No reply siblings are touched.
 */
interface Props {
  orgSlug: string;
  approvalId: string;
  /** The DM body to copy (edited_body-resolved upstream). */
  body: string;
  /**
   * Detail URL of the next pending lead, for auto-advance after this DM
   * resolves. Null when it's the last pending lead (fall back to the queue).
   */
  nextHref?: string | null;
  /**
   * Filtered queue URL to return to when there's no next lead, so the active
   * filter survives. Defaults to the bare queue when no filter is active.
   */
  listHref?: string;
  /** Recipient's numeric X id — opens the X DM composer pre-filled. */
  recipientId?: string | null;
}

export function DMReviewPanel({
  orgSlug,
  approvalId,
  body,
  nextHref,
  listHref,
  recipientId,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  // Editable DM body, seeded from the drafter's text. We mark-sent THIS value
  // and pass the original `body` as `originalBody`, so when they differ the
  // `edited` flag fires and api-vm persists payload.edited_body.
  const [draft, setDraft] = React.useState<string>(body);
  const seededFor = React.useRef<string>(body);
  React.useEffect(() => {
    if (seededFor.current !== body) {
      seededFor.current = body;
      setDraft(body);
    }
  }, [body]);
  const edited = draft !== body;
  const [sendResult, setSendResult] = React.useState<SendDraftResult | null>(
    null,
  );
  const [skipResult, setSkipResult] = React.useState<SkipDraftResult | null>(
    null,
  );
  const [parkResult, setParkResult] = React.useState<ParkDraftResult | null>(
    null,
  );
  const success = sendResult?.ok || skipResult?.ok || parkResult?.ok;

  // Advance to the next pending lead after the row resolves (or back to the
  // queue when it was the last), matching DraftReviewPanel.
  React.useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => {
      router.refresh();
      router.push(nextHref ?? listHref ?? `/app/${orgSlug}/approvals`);
    }, 1200);
    return () => clearTimeout(t);
  }, [success, router, orgSlug, nextHref, listHref]);

  const onMarkSent = () => {
    if (pending) return;
    const outgoing = draft.trim() ? draft : body;
    setSendResult(null);
    startTransition(async () => {
      // originalBody = the drafter's DM; body = the (possibly edited) textarea.
      // When they differ, `edited` fires and api-vm folds edited_body into the
      // DM draft's payload (the manual-send branch of /send).
      const res = await sendDraft({
        orgSlug,
        approvalId,
        originalBody: body,
        body: outgoing,
      });
      setSendResult(res);
    });
  };

  const onSkip = () => {
    if (pending) return;
    setSkipResult(null);
    startTransition(async () => {
      const res = await skipDraft({ orgSlug, approvalId, reason: "skipped" });
      setSkipResult(res);
    });
  };

  // "Wait for reply": park this DM onto the person's Contacts page so you can
  // send it by hand once they reply on X (instead of sending it now).
  const onPark = () => {
    if (pending) return;
    setParkResult(null);
    startTransition(async () => {
      const res = await parkDraft({ orgSlug, approvalId });
      setParkResult(res);
    });
  };

  return (
    <div className={styles.panel}>
      <div className="eyebrow" style={{ marginBottom: 12 }}>
        Direct message · edit, copy, send on X, then mark sent
      </div>
      <div className="angle-stack">
        <div className="angle selected" style={{ cursor: "default" }}>
          <h4>
            <span className="num">DM</span>
            <span>Direct message</span>
            {edited ? (
              <span className="tag" style={{ color: "var(--accent)", fontSize: 10.5 }}>
                edited
              </span>
            ) : null}
            <span style={{ marginLeft: "auto", color: "var(--ink-soft)" }}>
              {draft.length} chars
            </span>
          </h4>
          {/* Editable DM. What's here is what you'll copy + mark sent; an edit
              that differs from the drafter's text persists as edited_body. */}
          <textarea
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={pending || !!success}
            rows={4}
            spellCheck
            aria-label="Editable DM body"
            placeholder="Edit the DM before you send it…"
            style={{
              width: "100%",
              minHeight: 96,
              resize: "vertical",
              fontSize: 14,
              lineHeight: 1.5,
              fontFamily: "inherit",
              whiteSpace: "pre-wrap",
            }}
          />
          {edited ? (
            <div style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setDraft(body)}
                disabled={pending || !!success}
                title="Discard your edit and restore the drafter's original DM"
              >
                Reset to draft
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div
        className="action-bar-phone"
        style={{
          display: "flex",
          gap: 10,
          marginTop: 22,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onSkip}
          disabled={pending || !!success}
        >
          Skip
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onPark}
          disabled={pending || !!success}
          title="Park this DM on the person's Contacts page — send it by hand once they reply on X"
        >
          Wait for reply
        </button>
        <div
          className="action-bar-primary"
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          {sendResult && !sendResult.ok ? (
            <span
              className="tag"
              style={{ color: "var(--danger)", fontSize: 11.5 }}
            >
              {sendResult.error.message}
            </span>
          ) : null}
          {skipResult && !skipResult.ok ? (
            <span
              className="tag"
              style={{ color: "var(--danger)", fontSize: 11.5 }}
            >
              {skipResult.error.message}
            </span>
          ) : null}
          {parkResult && !parkResult.ok ? (
            <span className="tag" style={{ color: "var(--danger)", fontSize: 11.5 }}>
              {parkResult.error.message}
            </span>
          ) : null}
          {sendResult?.ok ? (
            <span className="tag tag-ok">Marked sent ✓</span>
          ) : skipResult?.ok ? (
            <span className="tag">skipped</span>
          ) : parkResult?.ok ? (
            <span className="tag tag-ok">Parked — on their Contacts page ✓</span>
          ) : null}
          <CopyButton text={draft.trim() ? draft : body} label="Copy DM" />
          {/* Fast path: open the X DM composer pre-filled in your logged-in
              session (X has no DM-send API, so the agent can't auto-send DMs —
              this is the one-click manual send). Uses the edited text. */}
          <a
            href={buildXDmUrl(recipientId, draft.trim() ? draft : body)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn"
            style={{ background: "var(--danger)", color: "#fff", borderColor: "var(--danger)", textDecoration: "none" }}
            title="Open the X DM composer pre-filled — send it from X (one click)"
          >
            Send DM in X ↗
          </a>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onMarkSent}
            disabled={pending || !!success}
            title="Record this DM as sent (after you've sent it on X)"
          >
            {pending && !skipResult ? "Marking…" : "Mark as sent"}
          </button>
        </div>
      </div>
    </div>
  );
}

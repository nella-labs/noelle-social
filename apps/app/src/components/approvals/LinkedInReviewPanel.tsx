"use client";

import * as React from "react";
import styles from "./review-detail.module.css";
import { useRouter } from "next/navigation";
import { useCopy } from "@/lib/use-copy";
import { MarkSentButton } from "./MarkSentButton";
import { saveDraftEdit, skipDraft } from "@/app/app/[orgSlug]/approvals/actions";
import { StyleSourceBadge } from "@/components/approvals/StyleSourceBadge";
import { DraftDmButton } from "./DraftDmButton";
import type { LinkedInApprovalView } from "@/lib/queries";

/**
 * Draft-only review surface for a LinkedIn intern (Lyra) approval.
 *
 * Renders the reply angles + the DM Lyra drafted for one connection's post.
 * Each variant is its OWN approval row, so each gets its own copy button and
 * its own "Mark sent" — the operator copies the one they like, sends it on
 * LinkedIn by hand, then marks that specific draft sent.
 *
 * This manual surface prepares the draft and records an explicit operator
 * acknowledgment. Browser-posted replies are recorded by the actuator path.
 */
interface Props {
  orgSlug: string;
  /** All pending reply angles for this post (each its own approval). */
  replies: LinkedInApprovalView[];
  /** The pending DM for this post, if Lyra drafted one. */
  dm: LinkedInApprovalView | null;
  /** Next pending lead's detail URL, for auto-advance after Mark sent. */
  nextHref?: string | null;
  /** Queue URL to return to when this was the last pending lead. */
  listHref: string;
}

const ANGLE_LABEL: Record<string, string> = {
  empathetic: "Empathetic",
  technical: "Technical",
  contrarian: "Contrarian",
};

export function LinkedInReviewPanel({
  orgSlug,
  replies,
  dm,
  nextHref,
  listHref,
}: Props) {
  const { copiedKey, copy, copyError } = useCopy();
  const router = useRouter();
  const [skipping, startSkip] = React.useTransition();
  const [skipError, setSkipError] = React.useState<string | null>(null);

  // Skip the whole lead. The /skip route flips ALL of the lead's pending reply
  // angles to 'skipped' (and preserves the DM), so targeting any reply's
  // approval clears the lead — then advance like Mark sent does. Only offered
  // when there's a reply to skip (a DM-only post is marked sent or left).
  const onSkip = () => {
    const approvalId = replies[0]?.approvalId;
    if (!approvalId || skipping) return;
    setSkipError(null);
    startSkip(async () => {
      const res = await skipDraft({ orgSlug, approvalId, reason: "skipped from review" });
      if (res.ok) {
        router.refresh();
        router.push(nextHref ?? listHref);
      } else {
        setSkipError(res.error.message || "Couldn't skip — retry");
      }
    });
  };

  return (
    <div className={styles.panel} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {copyError ? <span role="status" className="tag" style={{ color: "var(--danger)" }}>{copyError}</span> : null}
      {replies.length > 0 ? (
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 12,
              flexWrap: "wrap",
            }}
          >
            <span className="eyebrow">
              {replies.length === 1
                ? "Reply · copy, send on LinkedIn, then mark sent"
                : `${replies.length} reply angles · copy one, send on LinkedIn, then mark sent`}
            </span>
            {skipError ? (
              <span
                className="tag"
                style={{ color: "var(--danger)", fontSize: 11 }}
              >
                {skipError}
              </span>
            ) : null}
            <span
              style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              {/* Draft the next DM to this person — Lyra warms up over a
                  progressive ladder toward a call, queued for approval. */}
              {replies[0]?.approvalId ? (
                <DraftDmButton orgSlug={orgSlug} approvalId={replies[0].approvalId} />
              ) : null}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={onSkip}
                disabled={skipping}
                title="Skip this lead — remove it from the queue (reversible under Status → Skipped)"
              >
                {skipping ? "Skipping…" : "Skip"}
              </button>
            </span>
          </div>
          <div className="angle-stack">
            {replies.map((r, i) => (
              <Variant
                key={r.approvalId}
                view={r}
                index={i}
                label={ANGLE_LABEL[r.angle ?? ""] ?? "Reply"}
                copiedKey={copiedKey}
                copy={copy}
                orgSlug={orgSlug}
                nextHref={nextHref}
                listHref={listHref}
              />
            ))}
          </div>
        </div>
      ) : null}

      {dm ? (
        <div>
          <div className="eyebrow" style={{ marginBottom: 12 }}>
            Direct message · copy, send on LinkedIn, then mark sent
          </div>
          <div className="angle-stack">
            <Variant
              view={dm}
              index={0}
              label="Direct message"
              isDM
              copiedKey={copiedKey}
              copy={copy}
              orgSlug={orgSlug}
              nextHref={nextHref}
              listHref={listHref}
            />
          </div>
        </div>
      ) : null}

      {replies.length === 0 && !dm ? (
        <div className="card">
          <div className="eyebrow">Nothing to review</div>
          <div
            style={{
              marginTop: 10,
              fontSize: 13,
              color: "var(--ink-muted)",
              lineHeight: 1.5,
            }}
          >
            Every draft for this post has already been actioned.
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Variant({
  view,
  index,
  label,
  isDM,
  copiedKey,
  copy,
  orgSlug,
  nextHref,
  listHref,
}: {
  view: LinkedInApprovalView;
  index: number;
  label: string;
  isDM?: boolean;
  copiedKey: string | null;
  copy: (text: string, key?: string) => Promise<boolean>;
  orgSlug: string;
  nextHref?: string | null;
  listHref: string;
}) {
  const original = view.body ?? "";
  const copied = copiedKey === view.approvalId;
  // Manual edits persist before copy or acknowledgment so the selected body
  // remains available to the existing learning path.
  const [draft, setDraft] = React.useState<string>(original);
  const seededFor = React.useRef<string>(original);
  React.useEffect(() => {
    if (seededFor.current !== original) {
      seededFor.current = original;
      setDraft(original);
    }
  }, [original]);
  const edited = draft !== original;

  const [editError, setEditError] = React.useState<string | null>(null);
  const [copyPending, startCopy] = React.useTransition();
  const persistEdit = async () => {
    setEditError(null);
    if (!edited) return true;
    if (!draft.trim()) { setEditError("The draft is empty."); return false; }
    try {
      const res = await saveDraftEdit({ orgSlug, approvalId: view.approvalId, body: draft });
      if (!res.ok) setEditError(res.error.message);
      return res.ok;
    } catch {
      setEditError("Couldn't save the edit — retry before recording a send.");
      return false;
    }
  };

  return (
    <div className="angle" style={{ cursor: "default" }}>
      <h4>
        <span className="num">{isDM ? "DM" : `0${index + 1}`}</span>
        <span>{label}</span>
        {edited ? (
          <span className="tag" style={{ color: "var(--accent)", fontSize: 10.5 }}>
            edited
          </span>
        ) : null}
        {!isDM ? (
          <StyleSourceBadge
            styleSource={view.styleSource}
            className="tag tag-info"
            style={{ fontSize: 10 }}
          />
        ) : null}
        <span style={{ marginLeft: "auto", color: "var(--ink-soft)" }}>
          {draft.length} chars
        </span>
      </h4>
      <textarea
        className="input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={isDM ? 4 : 3}
        spellCheck
        aria-label={isDM ? "Editable DM body" : "Editable reply body"}
        placeholder="Edit the draft before you copy + send it…"
        style={{
          width: "100%",
          minHeight: isDM ? 96 : 72,
          resize: "vertical",
          fontSize: 14,
          lineHeight: 1.5,
          fontFamily: "inherit",
          whiteSpace: "pre-wrap",
        }}
      />
      <div
        style={{
          display: "flex",
          gap: 10,
          marginTop: 14,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => startCopy(async () => {
            if (await persistEdit()) await copy(draft, view.approvalId);
          })}
          disabled={copyPending || !draft.trim()}
          title="Copy this draft. Mark sent after you send it on LinkedIn."
        >
          {copied ? "Copied ✓" : copyPending ? "Saving…" : "Copy"}
        </button>
        {edited ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setDraft(original)}
            title="Discard your edit and restore Lyra's original draft"
          >
            Reset to draft
          </button>
        ) : null}
        <span className="grow-phone" style={{ marginLeft: "auto" }}>
          <MarkSentButton
            orgSlug={orgSlug}
            approvalId={view.approvalId}
            nextHref={nextHref}
            listHref={listHref}
            beforeMarkSent={persistEdit}
          />
        </span>
      </div>
      {editError ? <span role="status" className="tag" style={{ color: "var(--danger)" }}>{editError}</span> : null}
    </div>
  );
}

"use client";

import * as React from "react";
import styles from "./review-detail.module.css";
import { useRouter } from "next/navigation";
import { useCopy } from "@/lib/use-copy";
import { MarkSentButton } from "./MarkSentButton";
import { saveDraftEdit, skipDraft } from "@/app/app/[orgSlug]/approvals/actions";
import type { RedditApprovalView } from "@/lib/queries";

/**
 * Review surface for a Reddit intern (Orion) approval.
 *
 * Renders the reply angle(s) Orion drafted for one thread. Each variant is its
 * OWN approval row. Orion AUTO-SENDS: an approved reply is posted to Reddit by
 * the Reddit actuator (from the operator's logged-in tab) — everything queued
 * here is treated as approved. The operator's control is to EDIT the reply or
 * SKIP it before it goes out; there is no manual "Send" button in the dashboard
 * because sending is automatic. Replies only (Reddit has no DM lane).
 */
interface Props {
  orgSlug: string;
  /** All pending reply angles for this thread (each its own approval). */
  replies: RedditApprovalView[];
  /** Next pending lead's detail URL, for auto-advance after Mark sent. */
  nextHref?: string | null;
  /** Queue URL to return to when this was the last pending lead. */
  listHref: string;
}

export function RedditReviewPanel({ orgSlug, replies, nextHref, listHref }: Props) {
  const { copiedKey, copy } = useCopy();
  const router = useRouter();
  const [skipping, startSkip] = React.useTransition();
  const [skipError, setSkipError] = React.useState<string | null>(null);

  // Skip the whole lead. The /skip route flips ALL of the lead's pending reply
  // angles to 'skipped', so targeting any reply's approval clears the lead —
  // then advance like Mark sent does.
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

  if (replies.length === 0) {
    return (
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
          Every draft for this thread has already been actioned.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
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
              ? "Reply · copy, post on Reddit, then mark sent"
              : `${replies.length} reply angles · copy one, post on Reddit, then mark sent`}
          </span>
          {skipError ? (
            <span className="tag" style={{ color: "var(--danger)", fontSize: 11 }}>
              {skipError}
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onSkip}
            disabled={skipping}
            title="Skip this thread — remove it from the queue (reversible under Status → Skipped)"
            style={{ marginLeft: "auto" }}
          >
            {skipping ? "Skipping…" : "Skip"}
          </button>
        </div>
        <div className="angle-stack">
          {replies.map((r, i) => (
            <Variant
              key={r.approvalId}
              view={r}
              index={i}
              copiedKey={copiedKey}
              copy={copy}
              orgSlug={orgSlug}
              nextHref={nextHref}
              listHref={listHref}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Variant({
  view,
  index,
  copiedKey,
  copy,
  orgSlug,
  nextHref,
  listHref,
}: {
  view: RedditApprovalView;
  index: number;
  copiedKey: string | null;
  copy: (text: string, key?: string) => void;
  orgSlug: string;
  nextHref?: string | null;
  listHref: string;
}) {
  const original = view.body ?? "";
  const copied = copiedKey === view.approvalId;
  const [draft, setDraft] = React.useState<string>(original);
  const seededFor = React.useRef<string>(original);
  React.useEffect(() => {
    if (seededFor.current !== original) {
      seededFor.current = original;
      setDraft(original);
    }
  }, [original]);
  const edited = draft !== original;

  return (
    <div className="angle" style={{ cursor: "default" }}>
      <h4>
        <span className="num">{`0${index + 1}`}</span>
        <span>Reply</span>
        {edited ? (
          <span className="tag" style={{ color: "var(--accent)", fontSize: 10.5 }}>
            edited
          </span>
        ) : null}
        <span style={{ marginLeft: "auto", color: "var(--ink-soft)" }}>
          {draft.length} chars
        </span>
      </h4>
      <textarea
        className="input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        spellCheck
        aria-label="Editable reply body"
        placeholder="Edit the reply before Orion sends it…"
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
          onClick={() => copy(draft, view.approvalId)}
          title="Copy this draft to your clipboard"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
        {edited ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setDraft(original)}
            title="Discard your edit and restore Orion's original draft"
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
            beforeMarkSent={
              edited && draft.trim()
                ? async () => {
                    const res = await saveDraftEdit({
                      orgSlug,
                      approvalId: view.approvalId,
                      body: draft,
                    });
                    return res.ok;
                  }
                : undefined
            }
          />
        </span>
      </div>
    </div>
  );
}

"use client";

import * as React from "react";
import { InboxSelectionControls } from "./InboxSelectionControls";
import styles from "./review-inbox.module.css";
import { AppLink as Link } from "@/components/nav/AppLink";
import { useRouter } from "next/navigation";
import type { RedditApprovalView } from "@/lib/queries";
import { timeAgo } from "@/lib/utils";
import { useIsMobile } from "@/lib/hooks/useMediaQuery";
import {
  bulkSkipDrafts,
  skipDraft,
  unskipDraft,
} from "@/app/app/[orgSlug]/approvals/actions";

/**
 * Review inbox for the Reddit intern (Orion) — one row per pending thread.
 *
 * Orion AUTO-SENDS: every pending row is treated as approved and posted to
 * Reddit by the actuator. Clicking a row deep-links to the approval detail to
 * edit or Skip it before it goes out. Reddit is replies-only (no DM lane), so
 * there's no DM toggle. The per-row Skip/Unskip and the multi-select "Skip
 * selected" bar are the veto — Skip a reply and the actuator never posts it.
 */
interface Props {
  rows: RedditApprovalView[];
  orgSlug: string;
  /** Org id — needed for the bulk Skip action. */
  orgId: string;
  /** Active Reddit filters as a `?...` suffix, carried onto each row's detail link. */
  filterQuery?: string;
}

export function RedditReviewInbox({
  rows,
  orgSlug,
  orgId,
  filterQuery = "",
}: Props) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [lastN, setLastN] = React.useState(10);
  const [pending, startTransition] = React.useTransition();
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const isMobile = useIsMobile();

  const selectableIds = rows
    .filter((r) => r.status === "pending")
    .map((r) => r.approvalId);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAll = () => setSelected(new Set(selectableIds));
  const clear = () => setSelected(new Set());
  const selectLastN = () =>
    setSelected(
      new Set(selectableIds.slice(Math.max(0, selectableIds.length - lastN))),
    );

  const onSkipSelected = () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setMsg(null);
    startTransition(async () => {
      const res = await bulkSkipDrafts({ orgSlug, orgId, approvalIds: ids });
      if (res.ok) {
        setMsg({
          ok: true,
          text: `Skipped ${res.count} draft${res.count === 1 ? "" : "s"} · find them under Status → Skipped`,
        });
        setSelected(new Set());
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message || "Couldn't skip — retry" });
      }
    });
  };

  if (rows.length === 0) {
    return (
      <div className={styles.empty}>
        Orion hasn&rsquo;t drafted anything yet. New drafts for threads on your
        subreddit watchlist land here automatically.
      </div>
    );
  }

  const count = selected.size;

  return (
    <div className={styles.inbox}>
      <InboxSelectionControls
        count={count}
        lastN={lastN}
        selectableCount={selectableIds.length}
        pending={pending}
        onSelectAll={selectAll}
        onSelectLast={selectLastN}
        onLastNChange={setLastN}
        onClear={clear}
        onSkip={onSkipSelected}
        message={msg}
      />

      {/* Column header — desktop grid only; the phone card stack self-labels. */}
      {isMobile ? null : (
        <div className={`${styles.columns} ${styles.simple}`}>
          <span />
          <span>Subreddit</span>
          <span>Thread</span>
          <span style={{ textAlign: "right" }}>Post age</span>
          <span />
        </div>
      )}
      {rows.map((row) => (
        <InboxRow
          key={row.approvalId}
          row={row}
          orgSlug={orgSlug}
          filterQuery={filterQuery}
          selected={selected.has(row.approvalId)}
          onToggle={() => toggle(row.approvalId)}
          mobile={isMobile}
        />
      ))}
    </div>
  );
}

function InboxRow({
  row,
  orgSlug,
  filterQuery,
  selected,
  onToggle,
  mobile = false,
}: {
  row: RedditApprovalView;
  orgSlug: string;
  filterQuery: string;
  selected: boolean;
  onToggle: () => void;
  mobile?: boolean;
}) {
  const router = useRouter();
  const [busy, startRow] = React.useTransition();
  const isPending = row.status === "pending";
  const isSkipped = row.status === "skipped";
  const preview = row.threadTitle ?? row.postText ?? row.body ?? "(no source thread synced)";
  const pushed = row.createdAt ? timeAgo(row.createdAt) : "—";
  // Post age is the reply-latency signal the reviewer actually needs: how long
  // ago the THREAD was posted (not when the draft was pushed). timeAgo reads the
  // discovery-stamped posted_at, now preserved end-to-end. `stale` flags threads
  // whose live upvote window has likely closed — a purely visual reviewer hint,
  // independent of the worker's REDDIT_MAX_POST_AGE_HOURS cull.
  const STALE_POST_HOURS = 24;
  const postAge = row.postedAt ? timeAgo(row.postedAt) : null;
  const postAgeMs = row.postedAt ? Date.now() - new Date(row.postedAt).getTime() : NaN;
  const stale = Number.isFinite(postAgeMs) && postAgeMs > STALE_POST_HOURS * 3_600_000;
  const ageLabel = postAge ?? pushed;
  const ageTitle = `Thread posted ${postAge ?? "unknown"} · pushed to inbox ${pushed}`;
  const sub = row.subreddit ? `r/${row.subreddit}` : row.authorHandle ? `u/${row.authorHandle}` : "—";
  const detailHref = `/app/${orgSlug}/approvals/${row.approvalId}${filterQuery}`;

  const onSkip = () =>
    startRow(async () => {
      await skipDraft({ orgSlug, approvalId: row.approvalId });
      router.refresh();
    });
  const onUnskip = () =>
    startRow(async () => {
      await unskipDraft({ orgSlug, approvalId: row.approvalId });
      router.refresh();
    });

  const actionBtn = isSkipped ? (
    <button
      type="button"
      onClick={onUnskip}
      disabled={busy}
      title="Un-skip — return this draft to the pending queue"
      className="inbox-rowbtn"
      style={{
        justifySelf: "center",
        border: "none",
        background: "transparent",
        cursor: busy ? "default" : "pointer",
        color: "var(--ink-muted)",
        fontSize: 14,
        lineHeight: 1,
        padding: 4,
      }}
    >
      ↩
    </button>
  ) : isPending ? (
    <button
      type="button"
      onClick={onSkip}
      disabled={busy}
      title="Skip — remove this draft from the queue (reversible under Status → Skipped)"
      className="inbox-rowbtn"
      style={{
        justifySelf: "center",
        border: "none",
        background: "transparent",
        cursor: busy ? "default" : "pointer",
        color: "var(--ink-muted)",
        fontSize: 15,
        lineHeight: 1,
        padding: 4,
      }}
    >
      ✕
    </button>
  ) : null;

  // ─── Phone: one card per thread ────────────────────────────────────────────
  if (mobile) {
    return (
      <div className={`row-card ${styles.mobileRow}`} style={{ gap: 8 }}>
        <div className="row-card-head" style={{ alignItems: "flex-start" }}>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            disabled={!isPending}
            title={isPending ? "Select to skip" : "Only pending drafts are selectable"}
            style={{
              width: 18,
              height: 18,
              marginTop: 2,
              flexShrink: 0,
              cursor: isPending ? "pointer" : "default",
            }}
          />
          <Link
            href={detailHref}
            className="inbox-handle"
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              gap: 6,
              whiteSpace: "normal",
              textDecoration: "none",
              color: "inherit",
            }}
          >
            {sub}
          </Link>
          {actionBtn}
        </div>
        <Link
          href={detailHref}
          className="inbox-preview"
          style={{ textDecoration: "none", color: "var(--ink-muted)" }}
        >
          &ldquo;{preview}&rdquo;
        </Link>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--ink-soft)",
          }}
        >
          <span title={ageTitle} style={stale ? { color: "var(--danger, #b4432f)" } : undefined}>
            {ageLabel}
            {stale ? " · stale" : ""}
          </span>
          {row.authorHandle ? <span>· u/{row.authorHandle}</span> : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${styles.row} ${styles.simple}`}
      data-selected={selected || undefined}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        disabled={!isPending}
        title={isPending ? "Select to skip" : "Only pending drafts are selectable"}
        style={{
          width: 16,
          height: 16,
          cursor: isPending ? "pointer" : "default",
        }}
      />
      <Link
        href={detailHref}
        style={{ textDecoration: "none", color: "inherit", display: "block", minWidth: 0 }}
      >
        <div
          className="inbox-handle"
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          {sub}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--ink-muted)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.authorHandle ? `u/${row.authorHandle}` : "—"}
        </div>
      </Link>
      <Link
        href={detailHref}
        className="inbox-preview"
        style={{ textDecoration: "none", color: "inherit" }}
      >
        &ldquo;{preview}&rdquo;
      </Link>
      <div
        className="inbox-time"
        title={ageTitle}
        style={stale ? { color: "var(--danger, #b4432f)" } : undefined}
      >
        {ageLabel}
        {stale ? <span style={{ display: "block", fontSize: 9, opacity: 0.8 }}>stale</span> : null}
      </div>
      {actionBtn ?? <span />}
    </div>
  );
}

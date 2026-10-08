"use client";

import * as React from "react";
import { InboxSelectionControls } from "./InboxSelectionControls";
import styles from "./review-inbox.module.css";
import { AppLink as Link } from "@/components/nav/AppLink";
import { ReplyReadinessBadge } from "./ReplyReadinessBadge";
import { isXReplyReady } from "@/lib/reply-readiness";
import { useRouter } from "next/navigation";
import type { PendingApprovalRow } from "@/lib/queries";
import { draftPayload, leadPayload, sentReplyUrl } from "@/lib/payload-shapes";
import { timeAgo } from "@/lib/utils";
import { AutoSendChip } from "@/components/approvals/AutoSendChip";
import { useShowDms } from "@/lib/hooks/useShowDms";
import { isXApprovalDm, visibleXReviewRows } from "@/lib/dm-visibility";
import { useIsMobile } from "@/lib/hooks/useMediaQuery";
import {
  scheduleAutoSend,
  bulkSkipDrafts,
  skipDraft,
  unskipDraft,
} from "@/app/app/[orgSlug]/approvals/actions";

/**
 * The "Review" inbox — one row per pending LEAD. Clicking a row deep-links to
 * the detail page; the checkboxes let the operator multi-select leads and queue
 * them for staggered, jittered auto-send ("Auto-send selected"). Each selected
 * lead's representative reply approval is scheduled; the api-vm skips that
 * lead's other angles and the send worker fires them at the scheduled times.
 */
interface Props {
  rows: PendingApprovalRow[];
  orgSlug: string;
  orgId: string;
  /** Active queue filters as a URL suffix, carried onto each row's detail link. */
  filterQuery?: string;
  /**
   * True when the list is empty ONLY because the active filters hid a non-empty
   * backlog — drives a "no matches / clear filters" empty state instead of the
   * "intern hasn't drafted anything" copy (which reads as broken).
   */
  filteredEmpty?: boolean;
  /** Where "Clear filters" navigates — the default unfiltered pending view. */
  clearHref?: string;
}

export function ReviewInbox({
  rows: allRows,
  orgSlug,
  orgId,
  filterQuery = "",
  filteredEmpty = false,
  clearHref = "",
}: Props) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [lastN, setLastN] = React.useState(10);
  const [pending, startTransition] = React.useTransition();
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [showDms] = useShowDms();
  const isMobile = useIsMobile();

  const allReviewRows = React.useMemo(
    () => visibleXReviewRows(allRows, true),
    [allRows],
  );
  const rows = React.useMemo(
    () => visibleXReviewRows(allRows, showDms),
    [allRows, showDms],
  );
  const hiddenDmCount = allReviewRows.filter(isXApprovalDm).length;

  // Only reply leads can be queued for auto-send. Friendly DMs stay manual.
  const selectable = rows.filter((r) => !isXApprovalDm(r) && !r.approval.auto_send_target_at);
  const selectableIds = selectable.map((r) => r.approval.id);

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
    setSelected(new Set(selectableIds.slice(Math.max(0, selectableIds.length - lastN))));

  const onQueue = () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setMsg(null);
    startTransition(async () => {
      const res = await scheduleAutoSend({ orgSlug, orgId, approvalIds: ids });
      if (res.ok) {
        const fmt = (iso: string | null) =>
          iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
        setMsg({
          ok: true,
          text:
            `Queued ${res.count} for auto-send · first ~${fmt(res.firstAt)}, last ~${fmt(res.lastAt)} (spread out, ~5-6/hr)` +
            (res.withheld > 0 ? ` · ${res.withheld} left unscheduled` : ""),
        });
        setSelected(new Set());
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message || "Couldn't queue — retry" });
      }
    });
  };

  // Bulk soft-skip the selected leads — clears them from the queue (reversible
  // via the Skipped status filter). Shares the selection with auto-send.
  const onSkipSelected = () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setMsg(null);
    startTransition(async () => {
      const res = await bulkSkipDrafts({ orgSlug, orgId, approvalIds: ids });
      if (res.ok) {
        setMsg({ ok: true, text: `Skipped ${res.count} lead${res.count === 1 ? "" : "s"} · find them under Status → Skipped` });
        setSelected(new Set());
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message || "Couldn't skip — retry" });
      }
    });
  };

  if (rows.length === 0) {
    return filteredEmpty ? (
      <div className={styles.empty}>
        No drafts match these filters.{" "}
        <Link href={clearHref} style={{ color: "var(--accent)" }}>
          Clear filters
        </Link>{" "}
        to see the rest of the queue.
      </div>
    ) : (
      <div className={styles.empty}>
        {hiddenDmCount > 0
          ? `${hiddenDmCount} DM${hiddenDmCount === 1 ? " is" : "s are"} hidden. Choose Show DMs to review them.`
          : "The sync worker checks every minute. New drafts will land here automatically."}
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
        onQueue={onQueue}
        message={msg}
      />

      {/* Column header — desktop grid only; the phone card stack self-labels. */}
      {isMobile ? null : (
        <div className={`${styles.columns} ${styles.scored}`}>
          <span />
          <span>Handle · tier</span>
          <span>Source</span>
          <span style={{ textAlign: "right" }}>Pushed</span>
          <span style={{ textAlign: "right" }}>Tier</span>
          <span style={{ textAlign: "right" }}>Score</span>
          <span />
        </div>
      )}
      {rows.map((row) => (
        <InboxRow
          key={row.approval.id}
          row={row}
          orgSlug={orgSlug}
          filterQuery={filterQuery}
          selected={selected.has(row.approval.id)}
          onToggle={() => toggle(row.approval.id)}
          canSelect={!isXApprovalDm(row) && !row.approval.auto_send_target_at}
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
  canSelect,
  mobile = false,
}: {
  row: PendingApprovalRow;
  orgSlug: string;
  filterQuery: string;
  selected: boolean;
  onToggle: () => void;
  canSelect: boolean;
  mobile?: boolean;
}) {
  const router = useRouter();
  const [busy, startRow] = React.useTransition();
  const isSkipped = row.approval.status === "skipped";
  const onSkip = () =>
    startRow(async () => {
      await skipDraft({ orgSlug, approvalId: row.approval.id });
      router.refresh();
    });
  const onUnskip = () =>
    startRow(async () => {
      await unskipDraft({ orgSlug, approvalId: row.approval.id });
      router.refresh();
    });

  const lp = leadPayload(row.lead);
  const dp = draftPayload(row.draft);
  const kind = dp.kind ?? "reply";
  const readinessBadge = row.approval.status === "pending" && kind === "reply"
    ? <ReplyReadinessBadge ready={isXReplyReady(row)} />
    : null;
  const handle = lp.author_handle ? `@${lp.author_handle}` : "—";
  const followers = lp.author_followers;
  const followerLabel =
    followers != null && followers > 0
      ? `${(followers / 1000).toFixed(1)}k`
      : null;
  const tier = row.lead?.tier ?? lp.tier ?? null;
  const score = row.lead?.classifier_score ?? null;
  const scoreLabel = score != null ? Math.round(score * 100) : null;
  const scoreColor =
    score == null
      ? "var(--ink-muted)"
      : score >= 0.75
        ? "var(--accent)"
        : score >= 0.5
          ? "var(--ink-2)"
          : "var(--ink-muted)";
  const preview =
    lp.post_text ??
    dp.body ??
    dp.angles?.empathetic?.body ??
    dp.angles?.technical?.body ??
    dp.angles?.contrarian?.body ??
    "(no source post synced)";
  const pushed = row.approval.created_at ? timeAgo(row.approval.created_at) : "—";
  const alreadyScheduled = !!row.approval.auto_send_target_at;
  const selectTitle = kind === "dm"
    ? "Manual DM — review and mark sent; auto-send is off"
    : alreadyScheduled
      ? "Already queued for auto-send"
      : "Select for auto-send";

  // For a sent row, the live X permalink to Vega's reply (the post with the
  // reply in it). Rendered as a sibling anchor floated over the right edge so
  // it isn't nested inside the row's child Links (invalid HTML).
  const replyUrl =
    row.approval.status === "sent"
      ? sentReplyUrl({ sentUrl: dp.sent_url, authorHandle: lp.author_handle })
      : null;

  const detailHref = `/app/${orgSlug}/approvals/${row.approval.id}${filterQuery}`;

  // ─── Phone: one card per lead (checkbox + handle/score head, clamped
  // preview body, meta footer). The desktop "on X" overlay is inlined into
  // the footer here instead of being absolutely positioned. ───────────────
  if (mobile) {
    return (
      <div className={`row-card ${styles.mobileRow}`} style={{ gap: 8 }}>
        <div className="row-card-head" style={{ alignItems: "flex-start" }}>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            disabled={!canSelect}
            title={selectTitle}
            aria-label={`Select ${handle}`}
            style={{ width: 18, height: 18, marginTop: 2, flexShrink: 0, cursor: canSelect ? "pointer" : "default" }}
          />
          <Link
            href={detailHref}
            className="inbox-handle"
            style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, whiteSpace: "normal", textDecoration: "none", color: "inherit" }}
          >
            {handle}
            {kind === "dm" ? (
              <span className="tag tag-acc" style={{ height: 18, fontSize: 10, letterSpacing: "0.06em" }}>
                DM
              </span>
            ) : null}
          </Link>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <span className={tier === "T1" ? "tag tag-acc" : "tag"} style={{ height: 20 }}>
              {tier ?? "—"}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: scoreColor }}>
              {scoreLabel != null ? scoreLabel : "—"}
            </span>
          </div>
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
          <span>{pushed}</span>
          {alreadyScheduled ? <AutoSendChip targetAt={row.approval.auto_send_target_at!} /> : null}
          {readinessBadge}
          {followerLabel ? <span>· {followerLabel}</span> : null}
          {replyUrl ? (
            <a
              href={replyUrl}
              target="_blank"
              rel="noreferrer"
              className="tag tag-acc"
              style={{ height: 18, fontSize: 10, textDecoration: "none", marginLeft: "auto" }}
            >
              on X ↗
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  const inboxRow = (
    <div
      className={`${styles.row} ${styles.scored}`}
      data-selected={selected || undefined}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        disabled={!canSelect}
        title={selectTitle}
            aria-label={`Select ${handle}`}
        style={{ width: 16, height: 16, cursor: canSelect ? "pointer" : "default" }}
      />
      <Link
        href={`/app/${orgSlug}/approvals/${row.approval.id}${filterQuery}`}
        style={{ textDecoration: "none", color: "inherit", display: "block" }}
      >
        <div
          className="inbox-handle"
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          {handle}
          {kind === "dm" ? (
            <span
              className="tag tag-acc"
              style={{ height: 18, fontSize: 10, letterSpacing: "0.06em" }}
              title="Cold-outreach DM — copy and send on X yourself"
            >
              DM
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 2 }}>
          {tier ? (
            <>
              <span
                className="inbox-tier"
                style={{ color: tier === "T1" ? "var(--accent)" : "var(--ink-muted)" }}
              >
                {tier}
              </span>
              {followerLabel ? <span> · {followerLabel}</span> : null}
            </>
          ) : followerLabel ? (
            <span className="inbox-tier">{followerLabel}</span>
          ) : (
            <span className="inbox-tier">—</span>
          )}
        </div>
          {alreadyScheduled ? (
          <div style={{ marginTop: 4 }}>
            <AutoSendChip targetAt={row.approval.auto_send_target_at!} />
          </div>
          ) : null}
          {readinessBadge}
      </Link>
      <Link
        href={`/app/${orgSlug}/approvals/${row.approval.id}${filterQuery}`}
        className="inbox-preview"
        style={{ textDecoration: "none", color: "inherit" }}
      >
        &ldquo;{preview}&rdquo;
      </Link>
      <div className="inbox-time">{pushed}</div>
      <div style={{ textAlign: "right" }}>
        <span className={tier === "T1" ? "tag tag-acc" : "tag"} style={{ height: 20 }}>
          {tier ?? "—"}
        </span>
      </div>
      <div
        style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 12, color: scoreColor }}
        title={score == null ? "No score yet" : `Classifier score · ${score.toFixed(3)}`}
      >
        {scoreLabel != null ? scoreLabel : "—"}
      </div>
      {isSkipped ? (
        <button
          type="button"
          onClick={onUnskip}
          disabled={busy}
          title="Un-skip — return this lead to the pending queue"
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
      ) : (
        <button
          type="button"
          onClick={onSkip}
          disabled={busy}
          title="Skip — remove this lead from the queue (reversible under Status → Skipped)"
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
      )}
    </div>
  );

  if (!replyUrl) return inboxRow;

  return (
    <div style={{ position: "relative" }}>
      {inboxRow}
      <a
        href={replyUrl}
        target="_blank"
        rel="noreferrer"
        className="tag tag-acc"
        title="Open Vega's reply on X"
        style={{
          position: "absolute",
          top: "50%",
          right: 8,
          transform: "translateY(-50%)",
          zIndex: 2,
          fontSize: 10,
          height: 18,
          textDecoration: "none",
          background: "var(--paper)",
          boxShadow: "0 0 0 4px var(--paper)",
        }}
      >
        on X ↗
      </a>
    </div>
  );
}

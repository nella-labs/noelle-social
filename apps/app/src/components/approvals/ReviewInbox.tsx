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

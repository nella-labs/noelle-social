"use client";

import * as React from "react";
import { InboxSelectionControls } from "./InboxSelectionControls";
import styles from "./review-inbox.module.css";
import { AppLink as Link } from "@/components/nav/AppLink";
import { useRouter } from "next/navigation";
import type { LinkedInApprovalView } from "@/lib/queries";
import { StyleSourceBadge } from "@/components/approvals/StyleSourceBadge";
import { timeAgo } from "@/lib/utils";
import { useIsMobile } from "@/lib/hooks/useMediaQuery";
import { useShowDms } from "@/lib/hooks/useShowDms";
import { visibleLinkedInReviewRows } from "@/lib/dm-visibility";
import { isLinkedInReplyReady } from "@/lib/reply-readiness";
import { ReplyReadinessBadge } from "./ReplyReadinessBadge";
import {
  bulkSkipDrafts,
  skipDraft,
  unskipDraft,
} from "@/app/app/[orgSlug]/approvals/actions";

/**
 * Review inbox for the LinkedIn intern (Lyra) — one row per pending lead.
 *
 * Draft-only by construction: clicking a row deep-links to the LinkedIn
 * approval detail, where the action is copy + "Mark sent" (Lyra never posts to
 * LinkedIn). Hides the X-only tier / follower / score columns the X
 * `ReviewInbox` shows — LinkedIn discovery carries no such signals (every
 * watchlist-person post is a priority lead, no classifier).
 *
 * Parity with the X inbox MINUS posting: per-row Skip/Unskip (✕ / ↩) and a
 * multi-select "Skip selected" bar — but NO auto-send (Lyra has no send worker).
 * Skip flips the lead's pending reply angles to 'skipped' (the /skip route skips
 * siblings); it's reversible under Status → Skipped.
 */
interface Props {
  rows: LinkedInApprovalView[];
  orgSlug: string;
  /** Org id — needed for the bulk Skip action. */
  orgId: string;
  /** Active LinkedIn filters as a `?...` suffix, carried onto each row's detail
   *  link so the detail-page stepper walks the same filtered/collapsed set. */
  filterQuery?: string;
  voiceFloor?: number | null;
}

export function LinkedInReviewInbox({
  rows: allRows,
  orgSlug,
  orgId,
  filterQuery = "",
  voiceFloor = 0.7,
}: Props) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [lastN, setLastN] = React.useState(10);
  const [pending, startTransition] = React.useTransition();
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const isMobile = useIsMobile();
  const [showDms] = useShowDms();

  const allReviewRows = React.useMemo(
    () => visibleLinkedInReviewRows(allRows, true, voiceFloor),
    [allRows, voiceFloor],
  );
  const visibleRows = React.useMemo(
    () => visibleLinkedInReviewRows(allRows, showDms, voiceFloor),
    [allRows, showDms, voiceFloor],
  );
  const hiddenDmCount = allReviewRows.filter((row) => row.kind === "dm").length;

  // Bulk skip targets reply siblings. DMs stay available through their own
  // per-row skip action and never inflate the reply selection count.
  const selectableIds = visibleRows
    .filter((r) => r.status === "pending" && r.kind !== "dm")
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

  if (visibleRows.length === 0) {
    return (
      <div className={styles.empty}>
        {allRows.length > 0 && hiddenDmCount > 0 ? (
          <>
            No reply drafts right now. {hiddenDmCount} DM draft
            {hiddenDmCount === 1 ? "" : "s"} {hiddenDmCount === 1 ? "is" : "are"}{" "}
            hidden — choose <strong>Show DMs</strong> in the header to review them.
          </>
        ) : (
          <>
            Lyra hasn&rsquo;t drafted anything yet. New drafts for your LinkedIn
            connections&rsquo; posts land here automatically.
          </>
        )}
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
          <span>Connection</span>
          <span>Post</span>
          <span style={{ textAlign: "right" }}>Pushed</span>
          <span />
        </div>
      )}
      {visibleRows.map((row) => (
        <InboxRow
          key={row.approvalId}
          row={row}
          orgSlug={orgSlug}
          filterQuery={filterQuery}
          selected={selected.has(row.approvalId)}
          onToggle={() => toggle(row.approvalId)}
          canSelect={row.status === "pending" && row.kind !== "dm"}
          voiceFloor={voiceFloor}
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
  voiceFloor,
  mobile = false,
}: {
  row: LinkedInApprovalView;
  orgSlug: string;
  filterQuery: string;
  selected: boolean;
  onToggle: () => void;
  canSelect: boolean;
  voiceFloor: number | null;
  mobile?: boolean;
}) {
  const router = useRouter();
  const [busy, startRow] = React.useTransition();
  const isPending = row.status === "pending";
  const isSkipped = row.status === "skipped";
  const preview = row.postText ?? row.body ?? "(no source post synced)";
  const pushed = row.createdAt ? timeAgo(row.createdAt) : "—";
  const detailHref = `/app/${orgSlug}/approvals/${row.approvalId}${filterQuery}`;


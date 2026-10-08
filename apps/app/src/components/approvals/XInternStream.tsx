"use client";

import { StreamToolbar } from "./StreamToolbar";
import styles from "./stream-controls.module.css";
import { SpeedrunInbox } from "./SpeedrunInbox";
import { useInboxMode } from "@/lib/hooks/useInboxMode";
import { useShowDms } from "@/lib/hooks/useShowDms";
import { visibleSpeedrunDrafts } from "@/lib/dm-visibility";
import { DmVisibilityControl } from "./DmVisibilityControl";
import type { SpeedrunDraft } from "./SpeedrunRow";

/**
 * Wraps the X Intern queue contents: a small toolbar with the mode toggle,
 * then either the Review table (passed in as a server-rendered child) or
 * the in-memory Speedrun list.
 *
 * Why "ReviewInbox via children" rather than render-here? The server page
 * already fetches every PendingApprovalRow and renders the Review table
 * cleanly using server components (links, no client state). Passing that
 * JSX as `reviewSlot` keeps the SSR path identical to the previous design
 * — only the speedrun branch escapes to the client.
 *
 * Both branches share the same `useInboxMode` hook so toggling persists
 * across reloads.
 */

interface Props {
  /** SSR-rendered Review inbox; shown when mode === "review". */
  reviewSlot: React.ReactNode;
  /** Plain-object projection of approvals — used when mode === "speedrun". */
  speedrunDrafts: SpeedrunDraft[];
  /** Base path for "Full review →" links inside speedrun rows. */
  basePath: string;
  /** Active queue filters as a URL suffix, appended to "Full review" links so
   *  the detail stepper inherits the same filtered set. */
  filterQuery?: string;
  /** Approved pending replies — shown next to the toggle for orientation. */
  totalPending: number;
  status?: "pending" | "sent" | "skipped" | "all";
  /** DM rows available when the shared visibility control is on. */
  totalDms?: number;
  /** Deep-link target for the "Configure agent →" button (X intern config). */
  configureHref: string;
  /** Org slug — threaded to Speedrun for the markSentManual server action. */
  orgSlug: string;
  /** Empty ONLY because filters hid a non-empty backlog — forwarded to Speedrun. */
  filteredEmpty?: boolean;
  /** Where "Clear filters" navigates — the default unfiltered pending view. */
  clearHref?: string;
}

export function XInternStream({
  reviewSlot,
  speedrunDrafts,
  basePath,
  filterQuery = "",
  totalPending,
  status = "pending",
  totalDms = 0,
  configureHref,
  orgSlug,
  filteredEmpty = false,
  clearHref = "",
}: Props) {
  const [mode, setMode] = useInboxMode();
  const [showDms, setShowDms] = useShowDms();

  const visibleSpeedrun = visibleSpeedrunDrafts(speedrunDrafts, showDms);

  return (
    <section className={styles.workspace} aria-label="Approval queue">
      <StreamToolbar
        count={totalPending}
        title={status === "pending" ? "Approved replies" : status === "all" ? "All replies" : `${status[0]!.toUpperCase()}${status.slice(1)} replies`}
        description={status !== "pending" ? "Read-only reply history" : mode === "review" ? "Automatic review passed · actor sends within its send controls" : "Manual tools for already-approved replies"}
        mode={mode}
        setMode={setMode}
        configureHref={configureHref}
      >
        {showDms && totalDms > 0 ? <span className="tag">DMs · {totalDms}</span> : null}
        <DmVisibilityControl showDms={showDms} setShowDms={setShowDms} />
      </StreamToolbar>

      {mode === "review" ? (
        reviewSlot
      ) : (
        <SpeedrunInbox
          drafts={visibleSpeedrun}
          basePath={basePath}
          filterQuery={filterQuery}
          orgSlug={orgSlug}
          filteredEmpty={filteredEmpty}
          clearHref={clearHref}
        />
      )}
    </section>
  );
}

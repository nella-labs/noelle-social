"use client";

import * as React from "react";
import { StreamToolbar } from "./StreamToolbar";
import styles from "./stream-controls.module.css";
import { SpeedrunInbox } from "./SpeedrunInbox";
import { useInboxMode } from "@/lib/hooks/useInboxMode";
import { useShowDms } from "@/lib/hooks/useShowDms";
import { visibleSpeedrunDrafts } from "@/lib/dm-visibility";
import { DmVisibilityControl } from "./DmVisibilityControl";
import type { SpeedrunDraft } from "./SpeedrunRow";

/**
 * LinkedIn (Lyra) approvals stream: the Review ⇄ Speedrun toggle plus the
 * pending/draft-only chips. Mirrors XInternStream but draft-only — Speedrun
 * reuses the shared SpeedrunInbox with `platform="linkedin"` (no red Send, no
 * X composer; Copy + Mark sent only). Review is the server-rendered
 * LinkedInReviewInbox, passed in as `reviewSlot` so its SSR path is unchanged.
 *
 * `useInboxMode` is the same global Review/Speedrun preference the X tab uses,
 * so the operator's chosen mode is consistent across both inboxes.
 */
interface Props {
  /** SSR-rendered LinkedInReviewInbox; shown when mode === "review". */
  reviewSlot: React.ReactNode;
  /** One card per post (every reply angle), shown when mode === "speedrun". */
  speedrunDrafts: SpeedrunDraft[];
  /** Base path for "Full review →" links, e.g. `/app/<orgSlug>/approvals`. */
  basePath: string;
  /** Active LinkedIn filters as a URL suffix, appended to "Full review" links. */
  filterQuery?: string;
  /** Org slug — scopes the markSentManual server action. */
  orgSlug: string;
  /** Approved pending reply count for the chip. */
  pending: number;
  status?: "pending" | "sent" | "skipped" | "all";
  /** DM rows available when the shared visibility control is on. */
  dmCount?: number;
  /** Deep-link target for the "Configure agent →" button (Lyra's config). */
  configureHref: string;
}

export function LinkedInStream({
  reviewSlot,
  speedrunDrafts,
  basePath,
  filterQuery = "",
  orgSlug,
  pending,
  status = "pending",
  dmCount = 0,
  configureHref,
}: Props) {
  const [mode, setMode] = useInboxMode();
  const [showDms, setShowDms] = useShowDms();

  const visibleSpeedrun = visibleSpeedrunDrafts(speedrunDrafts, showDms);

  return (
    <section className={styles.workspace} aria-label="Approval queue">
      <StreamToolbar
        count={pending}
        title={status === "pending" ? "Approved replies" : status === "all" ? "All replies" : `${status[0]!.toUpperCase()}${status.slice(1)} replies`}
        description={status !== "pending" ? "Read-only reply history" : mode === "review" ? "Automatic review passed · actor sends within its send controls" : "Manual tools for already-approved replies"}
        mode={mode}
        setMode={setMode}
        configureHref={configureHref}
      >
        {showDms && dmCount > 0 ? <span className="tag">DMs · {dmCount}</span> : null}
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
          platform="linkedin"
        />
      )}
    </section>
  );
}

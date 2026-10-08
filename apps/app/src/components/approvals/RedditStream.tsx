"use client";

import * as React from "react";
import { StreamToolbar } from "./StreamToolbar";
import styles from "./stream-controls.module.css";
import { SpeedrunInbox } from "./SpeedrunInbox";
import { useInboxMode } from "@/lib/hooks/useInboxMode";
import type { SpeedrunDraft } from "./SpeedrunRow";

/**
 * Reddit (Orion) approvals stream: the Review ⇄ Speedrun toggle plus the
 * pending / auto-send chips. Mirrors LinkedInStream but replies-only — there's
 * no DM lane on Reddit, so no DMs toggle. Orion auto-sends approved replies via
 * the actuator; the queue is a review-and-Skip surface, not a manual sender.
 * Review is the server-rendered RedditReviewInbox, passed in
 * as `reviewSlot` so its SSR path is unchanged.
 *
 * `useInboxMode` is the same global Review/Speedrun preference the X and
 * LinkedIn tabs use, so the operator's chosen mode is consistent everywhere.
 */
interface Props {
  /** SSR-rendered RedditReviewInbox; shown when mode === "review". */
  reviewSlot: React.ReactNode;
  /** One card per thread (every reply angle), shown when mode === "speedrun". */
  speedrunDrafts: SpeedrunDraft[];
  /** Base path for "Full review →" links, e.g. `/app/<orgSlug>/approvals`. */
  basePath: string;
  /** Active Reddit filters as a URL suffix, appended to "Full review" links. */
  filterQuery?: string;
  /** Org slug — scopes the markSentManual server action. */
  orgSlug: string;
  /** Pending count for the chip. */
  pending: number;
  /** Deep-link target for the "Configure agent →" button (Orion's config). */
  configureHref: string;
}

export function RedditStream({
  reviewSlot,
  speedrunDrafts,
  basePath,
  filterQuery = "",
  orgSlug,
  pending,
  configureHref,
}: Props) {
  const [mode, setMode] = useInboxMode();

  return (
    <section className={styles.workspace} aria-label="Approval queue">
      <StreamToolbar
        count={pending}
        title="Pending replies"
        description="Orion auto-sends approved replies. Skip a reply to stop it before posting."
        mode={mode}
        setMode={setMode}
        configureHref={configureHref}
      >
        <span className="tag" title="Orion auto-sends approved replies via the Reddit actuator — Skip to veto one before it posts">Auto-send</span>
      </StreamToolbar>

      {mode === "review" ? (
        reviewSlot
      ) : (
        <SpeedrunInbox
          drafts={speedrunDrafts}
          basePath={basePath}
          filterQuery={filterQuery}
          orgSlug={orgSlug}
          platform="reddit"
        />
      )}
    </section>
  );
}

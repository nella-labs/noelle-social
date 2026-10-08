"use client";

import styles from "./speedrun.module.css";
import { AppLink as Link } from "@/components/nav/AppLink";
import { CopyButton } from "./CopyButton";
import { useCopy } from "@/lib/use-copy";
import type { AngleOption } from "./DraftReviewPanel";
import { StyleSourceBadge } from "./StyleSourceBadge";
import { VipFlagBanner } from "./VipFlagBanner";
import { DraftDmButton } from "./DraftDmButton";
import { buildXDmUrl } from "@/lib/x-dm-url";
import type { VipSignal } from "@noelle/contracts";
import { ReplyReadinessBadge } from "./ReplyReadinessBadge";

/**
 * One card per pending draft in Speedrun mode.
 *
 * Ported from screens.jsx `SpeedrunRow`. A header strip carries the lead's
 * handle/tier/source-quote and the global actions (full review, mark sent);
 * the body lists the three angles as radio rows, the picked one expanded
 * and ready to copy.
 *
 * Real data note: the design has a rich lead schema (name, tier, follower
 * count). Production data from noelle.leads.payload only has author handle
 * + post text reliably; tier and follower count fall back to neutral
 * placeholders rather than being faked.
 */

export interface SpeedrunDraft {
  /** approval UUID — used for "Full review" deep links. */
  id: string;
  lead: {
    handle: string;
    /** External URL to the lead's profile, if known. */
    profileUrl: string | null;
    tier: "T1" | "T2" | "T3" | null;
    followers: number | null;
    /** Source tweet id — used to thread the X compose link as a reply. */
    postId: string | null;
    /** Recipient's numeric X id — opens the X DM composer pre-filled. */
    recipientId: string | null;
    /** Classifier quality (0..1) mirrored from `noelle.leads.classifier_score`. */
    score: number | null;
  };
  /** Source post text (lp.post_text), if synced. */
  sourceTweet: string | null;
  /** Relative time-since-pushed label, e.g. "11m". */
  pushedAt: string;
  angles: AngleOption[];
  /** Draft kind. A DM renders a single copy-only card instead of angle radios. */
  kind: "reply" | "dm";
  /** Review state for this post; the actor's pacing and send switches still apply. */
  readyForActor?: boolean;
  reviewPolicyAvailable?: boolean;
  status?: string;
  /** DM body — present only when kind === "dm". */
  dmText?: string | null;
  /** Approval row for the DM, whether standalone or attached to a reply card. */
  dmApprovalId?: string | null;
  /** Direct URL to the source post. Both interns render a per-angle link that
   *  copies the reply as it opens this post — land on the post with the draft
   *  on your clipboard, then paste. Null only when there's no real post id
   *  (e.g. synthetic seed leads). */
  postUrl?: string | null;
  /**
   * Relationship-scout verdict for this lead's author (noelle.leads.vip_signal).
   * When `vip` is true, the row renders the gold VIP banner — same flag + intro
   * DM + add-to-watchlist the full review surface shows.
   */
  vipSignal?: VipSignal | null;
  /**
   * The reference the watchlist add needs: X handle (no @) or LinkedIn public_id.
   * Threaded so the VIP banner's "Add to watchlist" works straight from Speedrun.
   */
  watchlistRef?: string | null;
  /** Owning agent instance id — the VIP banner's watchlist action is scoped to it. */
  instanceId?: string | null;
  /**
   * Whether this author is ALREADY on the intern's watchlist. Drives the VIP
   * banner's "On watchlist ✓" vs "Add to watchlist" state so it survives a
   * reload (computed from the real watchlist table, not local button state).
   */
  alreadyWatched?: boolean;
}

interface Props {
  d: SpeedrunDraft;
  /** 1-indexed display number for the leading badge. */
  n: number;
  pickedId: string | null;
  onPick: (angleId: string) => void;
  isSent: boolean;
  /** Inline error from a failed mark-sent/send (shows next to the action). */
  error?: string | null;
  /** Explicit acknowledgment that the operator sent the selected draft by hand. */
  onMarkSent: (angleId?: string) => void;
  /** Agent posts the picked reply to X now (red Send). */
  onSend: () => void;
  /** Skip the whole lead — flips its pending reply angles to 'skipped'
   *  (reversible under Status → Skipped). Shown for both interns. */
  onSkip: () => void;
  fullReviewHref: string;
  /** Platform the card belongs to. "linkedin"/"reddit" are draft-only: no red
   *  Send and no X reply/DM composer deep-links — the operator copies + posts
   *  by hand. */
  platform?: "x" | "linkedin" | "reddit";
  /** Org slug — scopes the VIP banner's "Add to watchlist" server action. */
  orgSlug?: string;
}

export function SpeedrunRow({
  d,
  n,
  pickedId,
  onPick,
  isSent,
  error,
  onMarkSent,
  onSend,
  onSkip,
  fullReviewHref,
  platform = "x",
  orgSlug,
}: Props) {
  const canSend = platform === "x" && d.kind === "reply";
  // Draft-only "open the source + copy" affordance label per platform.
  const openLabel =
    platform === "linkedin" ? "Post ↗" : platform === "reddit" ? "Thread ↗" : "↗ X";
  // Both interns' per-angle open link copies the reply as it opens the source
  // post — you land on the post with the draft on your clipboard, just paste.
  // (X's old reply-composer deep-link was the flaky intent flow; this matches
  // what the LinkedIn card already did.)
  const { copy, copyError } = useCopy();
  const picked = d.angles.find((a) => a.id === pickedId) ?? d.angles[0];
  const followerLabel =
    d.lead.followers != null && d.lead.followers > 0
      ? `${(d.lead.followers / 1000).toFixed(1)}k`
      : null;

  return (
    <div
      className={styles.card}
      style={{
        opacity: isSent ? 0.55 : 1,
      }}
    >
      {/* VIP flag — same gold banner the full review surface shows, so the
          high-leverage author + suggested intro DM + add-to-watchlist are right
          here in the speed lane (where most reviewing happens). */}
      {d.vipSignal?.vip && orgSlug && d.instanceId && platform !== "reddit" ? (
        <div style={{ padding: "14px 14px 0" }}>
          <VipFlagBanner
            orgSlug={orgSlug}
            instanceId={d.instanceId}
            approvalId={d.id}
            platform={platform === "linkedin" ? "linkedin" : "x"}
            authorLabel={d.lead.handle}
            watchlistRef={d.watchlistRef ?? null}
            profileUrl={d.lead.profileUrl}
            alreadyWatched={d.alreadyWatched ?? false}
            signal={d.vipSignal}
          />
        </div>
      ) : null}

      {/* Header strip */}
      <div
        className={styles.head}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "var(--paper)",
            boxShadow: "0 0 0 0.5px var(--rule)",
            display: "grid",
            placeItems: "center",
            fontFamily: "var(--body)",
            fontSize: 12,
            color: "var(--ink-muted)",
          }}
        >
          {String(n).padStart(2, "0")}
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            {d.lead.profileUrl ? (
              <a
                href={d.lead.profileUrl}
                target="_blank"
                rel="noreferrer"
                style={{

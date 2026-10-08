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
                  fontFamily: "var(--body)",
                  fontSize: 12,
                  color: "var(--accent)",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {d.lead.handle} ↗
              </a>
            ) : (
              <span
                style={{
                  fontFamily: "var(--body)",
                  fontSize: 12,
                  color: "var(--ink)",
                }}
              >
                {d.lead.handle}
              </span>
            )}
            {d.lead.tier ? (
              <span
                className="tag"
                style={{
                  color:
                    d.lead.tier === "T1"
                      ? "var(--accent)"
                      : "var(--ink-muted)",
                }}
              >
                {d.lead.tier}
                {followerLabel ? ` · ${followerLabel}` : ""}
              </span>
            ) : followerLabel ? (
              <span className="tag">{followerLabel}</span>
            ) : null}
            {d.kind === "reply" && d.status === "pending" ? (
              <ReplyReadinessBadge ready={d.readyForActor === true}
                unavailable={d.reviewPolicyAvailable === false} />
            ) : null}
            {d.lead.score != null ? (
              <span
                className="tag"
                style={{
                  color:
                    d.lead.score >= 0.75
                      ? "var(--accent)"
                      : d.lead.score >= 0.5
                        ? "var(--ink-2)"
                        : "var(--ink-muted)",
                }}
                title="Classifier score"
              >
                q · {Math.round(d.lead.score * 100)}
              </span>
            ) : null}
            <span
              style={{
                fontSize: 11.5,
                color: "var(--ink-soft)",
                fontFamily: "var(--body)",
              }}
            >
              · {d.pushedAt}
            </span>
          </div>
          {d.sourceTweet ? (
            <div
              style={{
                marginTop: 6,
                fontSize: 13,
                color: "var(--ink-muted)",
                lineHeight: 1.65,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              <span style={{ color: "var(--ink-soft)" }}>↳ source:</span>{" "}
              &ldquo;{d.sourceTweet}&rdquo;
            </div>
          ) : null}
        </div>
        <div className={styles.actions}>
          {error ? (
            <span
              className="tag"
              style={{ color: "var(--danger)", fontSize: 11 }}
            >
              {error}
            </span>
          ) : null}
          <Link
            href={fullReviewHref}
            className="btn btn-sm btn-ghost"
            style={{ textDecoration: "none" }}
          >
            Full review →
          </Link>
          {isSent ? (
            <span
              className="btn btn-sm"
              aria-disabled="true"
              style={{ color: "var(--accent)", cursor: "default", opacity: 0.8 }}
            >
              ✓ Sent
            </span>
          ) : (
            <>
              {/* Skip the whole lead — clears it from the queue (reversible
                  under Status → Skipped). Same one-click skip the Review inbox
                  uses; shown for both interns. */}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={onSkip}
                title="Skip this lead — remove it from the queue (reversible under Status → Skipped)"
              >
                Skip
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => onMarkSent()}
                title={
                  d.kind === "dm"
                    ? `I sent this DM on ${platform === "linkedin" ? "LinkedIn" : "X"} by hand — just record it`
                    : canSend
                    ? "I already posted the picked reply on X by hand — just record it"
                    : platform === "reddit"
                      ? "Record this reply as sent — takes it out of the auto-send queue"
                      : "I already sent the picked reply on LinkedIn by hand — just record it"
                }
              >
                Mark sent
              </button>
              {/* Draft the next DM to this person (LinkedIn only, on a post/reply
                  card). Lyra warms up over a progressive ladder toward a call,
                  queued for approval — never auto-sent. */}
              {platform === "linkedin" && d.kind === "reply" && orgSlug ? (
                <DraftDmButton orgSlug={orgSlug} approvalId={d.id} />
              ) : null}
              {/* Agent posts the picked reply to X now (red). Draft-only
                  platforms (LinkedIn) never post, so no Send button. */}
              {canSend ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={onSend}
                  style={{ background: "var(--danger)", color: "#fff", borderColor: "var(--danger)" }}
                  title="The agent posts the picked reply to X now, via your connected account"
                >
                  Send →
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* Reply angles — pick one (the DM for this lead renders below). */}
      {d.angles.length > 0 ? (
      <div role="radiogroup" aria-label={`${d.lead.handle} reply options`}>
        {d.angles.map((a) => {
          const isPicked = a.id === (picked?.id ?? null);
          return (
            <div
              key={a.id}
              onClick={() => onPick(a.id)}
              role="radio"
              aria-checked={isPicked}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  onPick(a.id);
                }
              }}
              className={styles.angle}
              aria-label={a.kind}
            >
              <span
                aria-hidden
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  border: isPicked
                    ? "5px solid var(--accent)"
                    : "1.5px solid var(--rule)",
                  background: "var(--paper-2)",
                  justifySelf: "center",
                  transition: "border .15s",
                }}
              />
              <div className={styles.angleMeta}>
                <div
                  style={{
                    fontFamily: "var(--body)",
                    fontSize: 10.5,
                    letterSpacing: "0",
                    textTransform: "none",
                    color: isPicked ? "var(--accent)" : "var(--ink-muted)",
                  }}
                >
                  {a.kind}
                </div>
                <div
                  style={{
                    fontFamily: "var(--body)",
                    fontSize: 10,
                    color: "var(--ink-soft)",
                    marginTop: 3,
                  }}
                >
                  {a.quality != null ? (
                    <>q · {Math.round(a.quality * 100)} · </>
                  ) : null}
                  {a.text.length}ch
                </div>
                {/* Voice blend (Lyra only) — the same "Style: …%" the full
                    review surface shows, so you can see whose form shaped the
                    draft without leaving the speed lane. */}
                {a.styleSource ? (
                  <StyleSourceBadge
                    styleSource={a.styleSource}
                    className="tag tag-info"
                    style={{
                      marginTop: 5,
                      fontSize: 9,
                      whiteSpace: "normal",
                      lineHeight: 1.25,
                      display: "inline-block",
                    }}
                  />
                ) : null}
              </div>
              <div className={styles.angleText}
              >
                {a.text}
              </div>
              <div
                className={styles.angleActions}
                onClick={(e) => e.stopPropagation()}
              >
                <CopyButton text={a.text} />
                {/* Copy the reply AND open the source post in one click — land
                    on the post with the draft on your clipboard, then paste.
                    Same affordance both interns share; X keeps its "↗ X" label,
                    LinkedIn reads "Post ↗". */}
                {d.postUrl ? (
                  <a
                    href={d.postUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => {
                      onPick(a.id);
                      void copy(a.text);
                    }}
                    className="btn btn-sm btn-ghost"
                    style={{ padding: "0 10px", textDecoration: "none" }}
                    title="Copy this reply and open the source post. Mark sent after you post it."
                  >
                    {openLabel}
                  </a>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      ) : null}

      {copyError ? <span role="status" className="tag" style={{ color: "var(--danger)", margin: 12 }}>{copyError}</span> : null}

      {/* The lead's DM, in the SAME card — so you pick a reply angle AND see
          the DM together (one boxed card per lead, not separate rows). */}
      {d.dmText ? (
        <div
          style={{
            padding: "16px 20px",
            borderTop: "1px solid var(--rule)",
            background: "var(--paper-2)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--body)",
              fontSize: 10.5,
              letterSpacing: "0",
              textTransform: "none",
              color: "var(--accent)",
            }}
          >
            Direct message · {d.dmText.length}ch
          </div>
          <div
            style={{
              marginTop: 8,
              fontSize: 13.5,
              lineHeight: 1.5,
              color: "var(--ink)",
              whiteSpace: "pre-wrap",
            }}
          >
            {d.dmText}
          </div>
          <div
            style={{ display: "flex", gap: 8, marginTop: 12 }}
            onClick={(e) => e.stopPropagation()}
          >
            <CopyButton text={d.dmText} label="Copy DM" />
            {canSend ? (
              <a
                href={buildXDmUrl(d.lead.recipientId, d.dmText)}
                target="_blank"
                rel="noreferrer"
                className="btn btn-sm"
                style={{ background: "var(--danger)", color: "#fff", borderColor: "var(--danger)", textDecoration: "none" }}
                title="Open the X DM composer pre-filled — send it from X (one click)"
              >
                Send DM in X ↗
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

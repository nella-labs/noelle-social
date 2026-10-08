"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useCopy } from "@/lib/use-copy";
import type { VipSignal } from "@noelle/contracts";
import { addWatchlistPerson } from "@/app/app/[orgSlug]/agents/[instanceId]/watchlist-people-actions";
import { addLinkedInWatchlistPerson } from "@/app/app/[orgSlug]/agents/[instanceId]/linkedin-watchlist-actions";
import { parkVipIntroDm } from "@/app/app/[orgSlug]/approvals/vip-dm-actions";

/**
 * Loud, interrupting banner shown ABOVE the draft picker when the relationship
 * scout flagged this post's author as high-leverage (an ICP match, a founder /
 * investor — a YC founder — or simply someone whose connection would be unusually
 * impactful). The whole point is to catch the operator's eye BEFORE the reflex
 * "Send / Mark sent" so they consider a relationship move instead of a one-off
 * reply: add the person to the watchlist, and/or send the precomputed genuine
 * intro DM (a real question or coffee-chat ask — never a pitch).
 *
 * The suggested DM is precomputed by the classifier (api-vm has no LLM path), so
 * "generate" is instant: we just reveal + copy it. "Add to watchlist" reuses the
 * existing per-platform watchlist server actions, seeding the scout's reason as
 * the engagement objective so the drafter knows why this person matters.
 */
interface Props {
  orgSlug: string;
  /** The owning agent instance (x_intern or linkedin_intern). */
  instanceId: string;
  /**
   * A pending approval id for this lead. Lets "Park in DMs" stash the intro DM
   * as a real draft (the action resolves the lead + scout DM from it). Omit to
   * hide the park button (e.g. the lead is already fully actioned).
   */
  approvalId?: string | null;
  platform: "x" | "linkedin";
  /** Display label for the person, e.g. "@handle" or "Jane Doe". */
  authorLabel: string;
  /**
   * The reference the watchlist add needs: the X handle (without @) for Vega, or
   * the LinkedIn public_id for Lyra. Null disables the add button (we can't
   * identify the person to track).
   */
  watchlistRef: string | null;
  /** Public profile URL, so the operator can open it and send the DM by hand. */
  profileUrl?: string | null;
  /** Whether this author is already on the watchlist (hide the add button). */
  alreadyWatched?: boolean;
  signal: VipSignal;
}

const GOLD = "#9a6b1f";
const GOLD_TINT = "color-mix(in oklch, #d8a32a 16%, var(--paper))";

export function VipFlagBanner({
  orgSlug,
  instanceId,
  approvalId,
  platform,
  authorLabel,
  watchlistRef,
  profileUrl,
  alreadyWatched = false,
  signal,
}: Props) {
  const router = useRouter();
  const { copiedKey, copy } = useCopy();
  const [pending, startTransition] = React.useTransition();
  const [added, setAdded] = React.useState(alreadyWatched);
  const [error, setError] = React.useState<string | null>(null);
  const [dmPending, startDmTransition] = React.useTransition();
  const [parked, setParked] = React.useState(false);
  const [dmError, setDmError] = React.useState<string | null>(null);

  if (!signal.vip) return null;

  const onAddWatchlist = () => {
    if (!watchlistRef || pending || added) return;
    setError(null);
    startTransition(async () => {
      const objective = signal.reason?.trim() || "High-leverage connection";
      const res =
        platform === "linkedin"
          ? await addLinkedInWatchlistPerson({
              orgSlug,
              instanceId,
              publicId: watchlistRef,
              objective: objective.slice(0, 240),
            })
          : await addWatchlistPerson({
              orgSlug,
              instanceId,
              handle: watchlistRef,
              objectiveKind: "relationship",
              objectiveNote: objective.slice(0, 240),
            });
      if (res.ok) {
        setAdded(true);
        router.refresh();
      } else {
        setError(
          res.error === "forbidden"
            ? "Not allowed for this workspace"
            : res.error === "invalid"
              ? "Couldn't resolve this profile"
              : "Couldn't add — retry",
        );
      }
    });
  };

  const dm = signal.dm_soon && signal.suggested_dm?.trim() ? signal.suggested_dm.trim() : null;

  // Stash the intro DM as a real parked draft so it shows up in the inbox under
  // "DMs On" — for when you want to send it a bit later, not right now.
  const onParkDm = () => {
    if (!approvalId || dmPending || parked) return;
    setDmError(null);
    startDmTransition(async () => {
      const res = await parkVipIntroDm({ orgSlug, approvalId });
      if (res.ok) {
        setParked(true);
        router.refresh();
      } else {
        setDmError(
          res.error === "no_dm"
            ? "No DM to park"
            : res.error === "forbidden"
              ? "Not allowed for this workspace"
              : "Couldn't park — retry",
        );
      }
    });
  };

  return (
    <div
      style={{
        border: `1.5px solid ${GOLD}`,
        background: GOLD_TINT,
        borderRadius: 12,
        padding: 16,
        boxShadow: `0 0 0 4px color-mix(in oklch, ${GOLD} 12%, transparent)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <span aria-hidden style={{ fontSize: 17 }}>
          ⭐
        </span>
        <span
          style={{
            fontFamily: "var(--display)",
            fontSize: 17,
            color: GOLD,
            letterSpacing: 0.2,
          }}
        >
          High-leverage account — worth more than a reply
        </span>
        {signal.tags.length > 0 ? (
          <span style={{ display: "flex", gap: 6, marginLeft: "auto", flexWrap: "wrap" }}>
            {signal.tags.map((t) => (
              <span
                key={t}
                className="tag"
                style={{
                  fontSize: 10.5,
                  color: GOLD,
                  borderColor: `color-mix(in oklch, ${GOLD} 45%, var(--rule))`,
                  textTransform: "lowercase",
                }}
              >
                {t}
              </span>
            ))}
          </span>
        ) : null}
      </div>

      {signal.reason ? (
        <div
          style={{
            marginTop: 8,
            fontSize: 13.5,
            lineHeight: 1.5,
            color: "var(--ink)",
          }}
        >
          {signal.reason}
        </div>
      ) : null}

      {/* Suggested next moves — the whole reason to pause before posting. */}
      <div
        style={{
          marginTop: 12,
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}

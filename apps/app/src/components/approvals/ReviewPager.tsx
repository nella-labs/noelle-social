"use client";

import * as React from "react";
import { AppLink as Link } from "@/components/nav/AppLink";
import { useRouter } from "next/navigation";
import { arrowTarget } from "@/lib/review-pager";

/**
 * "Lead N of M" stepper for the approval detail page. Lets the operator walk
 * the whole pending queue with prev/next buttons and ←/→ keys, instead of
 * bouncing back to the list between leads.
 *
 * The page computes neighbors server-side (pagerNeighbors) and only renders
 * this when the current approval is actually in the pending queue. The keyboard
 * listener is attached on mount (no render-time work → hydration-safe) and
 * no-ops while a field is focused or a modifier is held.
 */
interface Props {
  orgSlug: string;
  /** 0-based position of the current lead in the pending queue. */
  index: number;
  total: number;
  prevId: string | null;
  nextId: string | null;
  /** Active queue filters as a URL suffix, re-appended to each hop so the
   *  filter survives prev/next navigation. */
  query?: string;
}

export function ReviewPager({
  orgSlug,
  index,
  total,
  prevId,
  nextId,
  query = "",
}: Props) {
  const router = useRouter();
  const hrefFor = (id: string) => `/app/${orgSlug}/approvals/${id}${query}`;
  const prevHref = prevId ? hrefFor(prevId) : null;
  const nextHref = nextId ? hrefFor(nextId) : null;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      const target = arrowTarget(e.key, prevHref, nextHref);
      if (target) {
        e.preventDefault();
        router.push(target);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prevHref, nextHref, router]);

  // Disabled ends stay real <button>s (focusable + announced as disabled),
  // not inert spans.
  const endStyle: React.CSSProperties = { opacity: 0.4 };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {prevHref ? (
        <Link
          href={prevHref}
          className="btn btn-sm btn-ghost"
          style={{ textDecoration: "none" }}
          aria-label="Previous lead (left arrow)"
        >
          ← Prev
        </Link>
      ) : (
        <button
          type="button"
          disabled
          className="btn btn-sm btn-ghost"
          style={endStyle}
          aria-label="Previous lead — already at the first"
        >
          ← Prev
        </button>
      )}
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 12,
          color: "var(--ink-muted)",
          whiteSpace: "nowrap",
        }}
      >
        Lead {index + 1} of {total}
      </span>
      {nextHref ? (
        <Link
          href={nextHref}
          className="btn btn-sm btn-ghost"
          style={{ textDecoration: "none" }}
          aria-label="Next lead (right arrow)"
        >
          Next →
        </Link>
      ) : (
        <button
          type="button"
          disabled
          className="btn btn-sm btn-ghost"
          style={endStyle}
          aria-label="Next lead — already at the last"
        >
          Next →
        </button>
      )}
    </div>
  );
}

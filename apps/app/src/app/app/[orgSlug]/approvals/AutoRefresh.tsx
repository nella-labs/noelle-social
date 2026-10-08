"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Client-side ticker that re-runs the parent RSC every `intervalMs` ms.
 * Mounted invisibly in /approvals so new drafts pushed by the X intern
 * appear without a manual refresh. `router.refresh()` re-fetches the
 * server component on the same route, picking up fresh DB reads.
 *
 * Pauses while the tab is hidden so a backgrounded dashboard doesn't
 * keep hammering Cloud SQL.
 */
export function AutoRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const id = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [intervalMs, router]);

  return null;
}

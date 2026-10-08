"use client";

import { useEffect } from "react";
import { ErrorScreen } from "@/components/error-screen";

/**
 * Dashboard-wide error boundary.
 *
 * Catches throws from the org layout + any page under /app — most importantly a
 * transient Cloud SQL connection failure in the layout's auth/org queries,
 * which otherwise propagates to the root boundary and renders the ENTIRE app
 * blank (no nav, no content, no message). Here it degrades to a retry instead.
 * `reset()` re-renders the segment, which re-runs the failed queries on a fresh
 * connection — so an intermittent connector blip recovers on one click.
 *
 * Fires above the nav shell (it replaces everything under /app), so it renders
 * the full-screen `ErrorScreen` panel rather than a one-off card.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Dashboard render failed:", error.digest, error);
  }, [error]);

  return (
    <ErrorScreen
      kind="500"
      primaryAction={{ label: "Retry", onClick: reset }}
      traceId={error.digest}
    />
  );
}

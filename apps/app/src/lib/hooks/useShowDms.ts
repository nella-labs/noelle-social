"use client";

import * as React from "react";

/**
 * Per-operator "show / hide DMs" preference for the Approvals views.
 *
 * Default is HIDDEN: the fast flow is replies-only — the operator speeds
 * through reply angles and only flips DMs on when they want to handle one
 * (e.g. after a watchlisted person engages back, they look the person up and
 * send the DM by hand). DMs to watchlisted people are never AI-drafted, so the
 * DMs this hides are cold-outreach drafts to non-watchlist leads.
 *
 * Synced across every consumer (the toolbar toggle + the Review/Speedrun
 * lists) via a custom window event, so toggling in one place re-renders the
 * others immediately. SSR-safe: renders hidden on the server, hydrates from
 * localStorage after mount.
 */
const STORAGE_KEY = "noelle.showDms";
const SYNC_EVENT = "noelle:showDms";

function readShow(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function useShowDms(): [boolean, (next: boolean) => void] {
  const [show, setShow] = React.useState(false);

  React.useEffect(() => {
    setShow(readShow());
    const onChange = () => setShow(readShow());
    window.addEventListener(SYNC_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(SYNC_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const setShowDms = React.useCallback((next: boolean) => {
    setShow(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // best-effort; in-memory state still updates
      }
      try {
        window.dispatchEvent(new Event(SYNC_EVENT));
      } catch {
        // best-effort cross-component sync
      }
    }
  }, []);

  return [show, setShowDms];
}

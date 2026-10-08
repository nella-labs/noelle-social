"use client";

import * as React from "react";

/**
 * Persistent review-vs-speedrun toggle for the Approvals inbox.
 *
 * Ported from the design dump's `ScreenApprovals` (screens.jsx) which stored
 * the chosen mode in `localStorage` under `noelle.inboxMode`. Keeping the
 * same key on purpose: the design's mock was the spec the user signed off
 * on, and matching it makes the persisted preference identical in spirit
 * even though we now hydrate from real data.
 */
export type InboxMode = "review" | "speedrun";

const STORAGE_KEY = "noelle.inboxMode";

function readMode(): InboxMode {
  if (typeof window === "undefined") return "review";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "speedrun" ? "speedrun" : "review";
  } catch {
    return "review";
  }
}

export function useInboxMode(): [InboxMode, (next: InboxMode) => void] {
  // SSR-safe: server renders "review" always (it's the default), the client
  // upgrades to localStorage's value after mount via useEffect. Avoids a
  // hydration mismatch warning when localStorage disagrees with the default.
  const [mode, setModeState] = React.useState<InboxMode>("review");

  React.useEffect(() => {
    setModeState(readMode());
  }, []);

  const setMode = React.useCallback((next: InboxMode) => {
    setModeState(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // localStorage can throw in private-browsing or storage-quota modes.
        // Persistence is best-effort — the in-memory state still updates.
      }
    }
  }, []);

  return [mode, setMode];
}

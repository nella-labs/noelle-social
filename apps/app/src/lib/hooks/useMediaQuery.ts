"use client";

import * as React from "react";

/**
 * Phone breakpoint for the dashboard. Matches the `@media (max-width: 768px)`
 * block in globals.css that introduces the phone tier (hamburger drawer,
 * single-column shell, card-stacked tables). Keep the two in lockstep — if you
 * move one, move the other.
 */
export const PHONE_MAX_WIDTH = 768;
const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

/**
 * SSR-safe media-query hook.
 *
 * Returns `false` on the server AND on the first client render, then upgrades
 * to the real match after mount via a `matchMedia` listener. Rendering `false`
 * on the first client paint (identical to the server) is the whole point: it
 * keeps the markup hydration-stable, so consumers that swap layouts on phone
 * (e.g. table → card stack) never trip the App Router into the dead-page
 * hydration-mismatch state. The cost is a one-frame flash of the desktop
 * layout on a real phone, which is invisible in practice and the safe trade.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    // addEventListener is the modern API; older Safari only has addListener.
    if (mql.addEventListener) {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return matches;
}

/** True when the viewport is at or below the phone breakpoint (≤768px). */
export function useIsMobile(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

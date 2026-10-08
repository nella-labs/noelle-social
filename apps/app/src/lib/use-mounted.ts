import { useEffect, useState } from "react";

/**
 * True only after the first client commit.
 *
 * Gate time-relative or timezone-dependent output — `Date.now()`, relative
 * "Xs ago", `toLocaleString`/`toLocaleDateString`, `Number#toLocaleString` —
 * behind this flag. Such values differ between the server render (UTC, server
 * locale) and the client, and a single mismatch aborts hydration of the route
 * segment, which silently kills ALL interactivity on the page (every button +
 * link dead, page-level effects never run) even though the SSR HTML still
 * shows. Render a stable placeholder until mounted, then fill in live values.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

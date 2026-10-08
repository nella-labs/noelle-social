/**
 * Active-hours gate for the Reddit intern (Orion).
 *
 * Reddit reads go through Apify (no Reddit login/cookie to protect), so there is
 * no human-hours pacing the way LinkedIn needs — Orion runs 24/7. This is kept as
 * a no-op so discovery's call site stays stable; it always returns true.
 */
export function withinActiveHours(): boolean {
  return true;
}

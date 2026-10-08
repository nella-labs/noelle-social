import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Canonical key for a LinkedIn handle. LinkedIn vanity slugs carry a trailing
 * `-<hex id>` (e.g. `kaia-tham-7bb065343`) when the profile has no custom vanity
 * URL; the same person can later set a clean vanity (`kaia-tham`). Stripping that
 * suffix (and lowercasing) collapses both forms to one key so a feeder source and
 * a watchlist contact for the same human de-dupe to a single contact. Keep this
 * in lockstep with the SQL `regexp_replace(handle, '-[0-9a-f]{6,}$', '')` used in
 * reconcileContactsForOrg + the feeder queries, and prettyHandle() in
 * StyleSourceBadge.tsx (which strips for display only).
 */
export function normalizeLinkedinHandle(handle: string): string {
  return handle.trim().toLowerCase().replace(/-[0-9a-f]{6,}$/i, "");
}

export function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

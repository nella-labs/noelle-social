/** Admit exact positive result counts, bounded by the available candidates. */
export function searchResultLimit(requested: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(requested) || requested < 1 || !Number.isSafeInteger(maximum) || maximum < 1) return 0;
  return Math.min(requested, maximum);
}

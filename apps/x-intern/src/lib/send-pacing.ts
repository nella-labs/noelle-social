/** Pure helpers for the cross-tick inter-send floor. No Date.now / Math.random
 * inside — caller passes nowMs + rand so these are unit-testable. See
 * docs/x-account-safety.md §4. */
export function isWithinInterSendFloor(args: {
  nowMs: number;
  nextSendAllowedAtMs: number | undefined;
}): boolean {
  return args.nowMs < (args.nextSendAllowedAtMs ?? 0);
}

export function nextSendAllowedAt(args: {
  nowMs: number;
  minMs: number;
  maxMs: number;
  rand: number;
}): number {
  const lo = Math.min(args.minMs, args.maxMs);
  const hi = Math.max(args.minMs, args.maxMs);
  const r = args.rand < 0 ? 0 : args.rand > 1 ? 1 : args.rand;
  return args.nowMs + Math.round(lo + (hi - lo) * r);
}

export interface RateBucket {
  tryTake(): boolean;
}

export function createRateBucket(opts: {
  tokens: number;
  windowMs: number;
  now?: () => number;
}): RateBucket {
  const now = opts.now ?? Date.now;
  let windowStart = now();
  let used = 0;
  return {
    tryTake() {
      const t = now();
      if (t - windowStart >= opts.windowMs) {
        windowStart = t;
        used = 0;
      }
      if (used >= opts.tokens) return false;
      used++;
      return true;
    },
  };
}

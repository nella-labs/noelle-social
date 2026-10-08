export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  float(min: number, max: number): number;
  jitter(base: number, frac: number): number;
  normal(mean: number, sd: number): number;
  logNormal(muLog: number, sigmaLog: number): number;
  gamma(k: number, theta: number): number;
  pickWeighted(weights: number[]): number;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const float = (min: number, max: number) => min + next() * (max - min);
  const int = (min: number, max: number) => Math.floor(float(min, max + 1));
  const jitter = (base: number, frac: number) => base + (next() * 2 - 1) * frac * base;

  // Box–Muller: produces a standard normal, scaled to (mean, sd)
  const normal = (mean: number, sd: number): number => {
    const u1 = next();
    const u2 = next();
    // avoid log(0)
    const u1safe = u1 === 0 ? Number.EPSILON : u1;
    const z = Math.sqrt(-2 * Math.log(u1safe)) * Math.cos(2 * Math.PI * u2);
    return mean + sd * z;
  };

  const logNormal = (muLog: number, sigmaLog: number): number =>
    Math.exp(normal(muLog, sigmaLog));

  // Gamma distribution: Marsaglia–Tsang method (handles fractional k)
  // For integer k this also works correctly (just slower than sum-of-exponentials).
  const gammaMT = (k: number): number => {
    if (k < 1) {
      // Boost trick: Gamma(k) = Gamma(k+1) * U^(1/k)
      const u = next();
      return gammaMT(k + 1) * Math.pow(u === 0 ? Number.EPSILON : u, 1 / k);
    }
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = normal(0, 1);
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = next();
      const x2 = x * x;
      if (u < 1 - 0.0331 * (x2 * x2)) return d * v;
      if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v;
    }
  };

  const gamma = (k: number, theta: number): number => gammaMT(k) * theta;

  const pickWeighted = (weights: number[]): number => {
    const total = weights.reduce((s, w) => s + w, 0);
    let threshold = next() * total;
    for (let i = 0; i < weights.length; i++) {
      threshold -= weights[i]!;
      if (threshold < 0) return i;
    }
    // Fallback to last index (floating point edge case)
    return weights.length - 1;
  };

  return { next, int, float, jitter, normal, logNormal, gamma, pickWeighted };
}

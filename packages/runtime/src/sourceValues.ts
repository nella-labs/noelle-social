/** Read a finite source number without coercing blank or absent values to zero. */
function sourceNumber(value: unknown): number | null {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

/** Nonnegative measured values may be fractional, such as duration or an average. */
export function readSourceNonnegativeNumber(...candidates: unknown[]): number | null {
  for (const value of candidates) {
    const number = sourceNumber(value);
    if (number !== null && number >= 0 && number <= Number.MAX_SAFE_INTEGER) return number;
  }
  return null;
}

/** Preserve unknown source counts and measured zero. */
export function readSourceCount(...candidates: unknown[]): number | null {
  for (const value of candidates) {
    const count = sourceNumber(value);
    if (count !== null && Number.isSafeInteger(count) && count >= 0) return count;
  }
  return null;
}

/** Average only measured counts; preserve the fractional mean and avoid sum overflow. */
export function measuredCountMean(values: readonly unknown[]): number | null {
  let mean = 0;
  let n = 0;
  for (const value of values) {
    const count = readSourceCount(value);
    if (count !== null) mean += (count - mean) / ++n;
  }
  return n ? mean : null;
}

/** An observed count ratio requires both measurements and a positive denominator. */
export function measuredSourceRatio(numerator: unknown, denominator: unknown): number | null {
  const a = readSourceCount(numerator);
  const b = readSourceCount(denominator);
  return a !== null && b !== null && b > 0 ? a / b : null;
}

/** Reddit vote scores are signed integers; a negative score is a measurement. */
export function readSourceVoteScore(...candidates: unknown[]): number | null {
  for (const value of candidates) {
    const score = sourceNumber(value);
    if (score !== null && Number.isSafeInteger(score)) return score;
  }
  return null;
}

/** Reject impossible calendar components before JavaScript can normalize them. */
export function readSourceTimestamp(...candidates: unknown[]): string | null {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (const value of candidates) {
    if (typeof value !== "string" || !value.trim()) continue;
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T| |$)/.exec(value.trim());
    const twitter = /^[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) \d{2}:\d{2}:\d{2} [+-]\d{4} (\d{4})$/.exec(value.trim());
    if (!iso && !twitter) continue;
    const year = Number(iso?.[1] ?? twitter?.[3]);
    const month = iso ? Number(iso[2]) : months.indexOf(twitter![1]!) + 1;
    const day = Number(iso?.[3] ?? twitter?.[2]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]!) continue;
    const parsed = new Date(value);
    const utcYear = parsed.getUTCFullYear();
    if (Number.isFinite(parsed.getTime()) && utcYear >= 1 && utcYear <= 9999) return parsed.toISOString();
  }
  return null;
}

/** Numeric source epochs require a declared unit and a four-digit calendar year. */
export function readSourceEpochTimestamp(value: unknown, unit: "seconds" | "milliseconds"): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  if (unit !== "seconds" && unit !== "milliseconds") return null;
  const parsed = new Date(unit === "seconds" ? value * 1000 : value);
  const year = parsed.getUTCFullYear();
  return Number.isFinite(parsed.getTime()) && year >= 1 && year <= 9999 ? parsed.toISOString() : null;
}

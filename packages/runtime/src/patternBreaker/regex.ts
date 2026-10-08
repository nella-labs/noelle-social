import { RE2JS } from "re2js";

export interface LearnedPattern {
  test(body: string): boolean;
  match(body: string): string | null;
}

const MAX_SOURCE = 512;
const MAX_EXPANSION = 4096;
const MAX_PROGRAM = 1024;
const MAX_CACHE = 32;
const cache = new Map<string, LearnedPattern | null>();

/** Bound counted-repeat expansion before the engine allocates a program.
 * The product is conservative across independent repeats; escapes and class
 * contents are literal here, not repetition syntax. */
function withinCompileBudget(source: string): boolean {
  if (!source || source.length > MAX_SOURCE) return false;
  let inClass = false;
  let expansion = 1;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\") { i++; continue; }
    if (source[i] === "[" && !inClass) { inClass = true; continue; }
    if (source[i] === "]" && inClass) { inClass = false; continue; }
    if (source[i] !== "{" || inClass) continue;
    const repeat = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(i));
    if (!repeat) continue;
    expansion *= Math.max(1, Number(repeat[2] || repeat[1]));
    if (source.length * expansion > MAX_EXPANSION) return false;
    i += repeat[0].length - 1;
  }
  return true;
}

/** Ordinary phrases match regardless of case. A leading [a-z] or [A-Z] is an
 * explicit first-letter check; apply it separately so the rest of a compound
 * pattern still matches case-insensitively. Unsupported or oversized patterns
 * return null for the caller's evidence-based structure fallback. */
export function compileLearnedPattern(source: string): LearnedPattern | null {
  if (!source || source.length > MAX_SOURCE) return null;
  if (cache.has(source)) return cache.get(source)!;
  let compiled: LearnedPattern | null = null;
  try {
    if (withinCompileBudget(source)) {
      const phrase = RE2JS.compile(RE2JS.translateRegExp(source), RE2JS.CASE_INSENSITIVE);
      if (phrase.programSize() <= MAX_PROGRAM) {
        const opener = source.startsWith("^[a-z]") ? /^[a-z]/
          : source.startsWith("^[A-Z]") ? /^[A-Z]/ : null;
        const match = (body: string): string | null => {
          if (opener && !opener.test(body)) return null;
          try { return phrase.exec(body)?.[0] ?? null; }
          finally { phrase.reset(); }
        };
        compiled = { match, test: (body) => match(body) !== null };
      }
    }
  } catch {
    // Unsupported syntax is never executed through the native regex engine.
  }
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(source, compiled);
  return compiled;
}

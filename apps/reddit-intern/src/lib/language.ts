/**
 * English-only language gate for the classifier.
 *
 * The operator only wants English leads: a non-English post (a French/Spanish/
 * German/Portuguese tweet) must never reach the drafter, which would otherwise
 * draft a reply in that language. We detect language at the CLASSIFIER stage so
 * a non-English lead is skipped before any draft is spent on it — and crucially
 * BEFORE the watchlist/priority bypass, so even an always-reply watched account's
 * non-English post is dropped.
 *
 * Why a deterministic detector (no franc / cld dependency):
 *  - The realistic non-English cases are all Latin-script European languages
 *    (French, Spanish, German, Portuguese, Italian). They are cheaply separable
 *    from English on SHORT text by two near-orthogonal signals.
 *  - Statistical detectors (franc, cld3) are unreliable below ~15-20 chars — the
 *    exact regime social posts live in — and add weight for no gain here.
 *
 * Two signals, combined conservatively (bias toward NOT skipping):
 *  1. Diacritics / punctuation English effectively never uses: é è ê ë à â ä
 *     ñ ü ö (as a vowel mark), ç ã õ í ó ú á ß, and the Spanish inverted ¿ ¡.
 *     One of these in a real sentence is a very strong non-English signal with
 *     almost no English false positives (English borrows "café"/"naïve" rarely,
 *     and a single such word alone is NOT enough to skip — see the gate).
 *  2. Stopword balance: counts of unmistakable non-English function words
 *     (le, la, des, une, qué, está, und, der, não…) vs English ones (the, and,
 *     is, you, to, of…). A post is non-English when its non-English stopword
 *     signal clearly beats its English one.
 *
 * The gate is deliberately lenient: text shorter than MIN_DETECT_CHARS (emoji,
 * "gm", a bare URL, "lol same") is ALWAYS treated as English — we only skip when
 * there's enough text to be confident, and we never skip a post that carries a
 * real English signal. Pure and `now`-free so it's trivially testable.
 */

/** Below this many letters of real text we never flag non-English (too short to be sure). */
export const MIN_DETECT_CHARS = 12;

/**
 * Diacritics + punctuation that English text effectively never produces. Each is
 * a strong per-character non-English signal. (Plain ASCII vowels are excluded —
 * only the accented forms appear here.)
 */
const NON_ENGLISH_CHARS =
  /[àâäãáåçèéêëíïîìñòóôöõùúûüýÿœæ¿¡ß]/i;

/**
 * Function words that are unmistakably non-English and common enough to appear in
 * a short post. Kept to HIGH-PRECISION tokens only: any token that is also a
 * real English word or a fragment English hyphenation produces is EXCLUDED, or a
 * lone occurrence terminally skips a real English post (the gate flags on a
 * single non-English stopword when no English stopword rescues it, and common
 * English function words like "a"/"am" are intentionally not in the English set).
 * Concretely excluded because English also uses them: "est" (EST/est.), "plus",
 * "con" (pros/cons), "die" (to die), "non" ("non-technical" tokenizes to "non"),
 * "che", "fare" (airfare) — plus the already-avoided "a"/"no"/"son"/"we".
 */
const NON_ENGLISH_STOPWORDS = new Set<string>([
  // French
  "le", "les", "des", "une", "deux", "sont", "été", "être", "avec",
  "pour", "pas", "mais", "vous", "nous", "ils", "elle", "elles",
  "ce", "cette", "ces", "dans", "sur", "qui", "que", "quoi", "très", "bien",
  "tout", "tous", "fait", "faire", "merci", "bonjour", "aujourd", "hui",
  "moi", "toi", "leur", "votre", "notre", "alors", "encore", "déjà", "jamais",
  // Spanish
  "los", "las", "una", "uno", "pero", "por", "para", "como", "más",
  "muy", "está", "están", "estoy", "eso", "esto", "esta", "este", "porque",
  "qué", "cuando", "donde", "hacer", "hace", "gracias", "hola", "también",
  "ahora", "siempre", "nunca", "nada", "todo", "todos", "ellos", "ustedes",
  // German
  "der", "das", "und", "ist", "nicht", "ein", "eine", "einen", "auch",
  "aber", "auf", "mit", "für", "ich", "wir", "sie", "habe", "haben", "wird",
  "werden", "sehr", "schon", "noch", "über", "oder", "wenn", "weil", "kann",
  // Portuguese
  "não", "também", "está", "você", "obrigado", "obrigada", "muito", "mais",
  "isso", "isto", "porque", "quando", "fazer", "tudo", "todos", "agora",
  "sempre", "nunca", "nada", "então", "ainda", "depois",
  // Italian
  "sono", "questo", "questa", "anche", "perché", "molto",
  "grazie", "ciao", "sempre", "adesso", "tutto", "tutti", "quando",
]);

/** Common English function words — presence of these is a strong English signal. */
const ENGLISH_STOPWORDS = new Set<string>([
  "the", "and", "is", "are", "was", "were", "you", "your", "to", "of", "in",
  "on", "for", "with", "this", "that", "these", "those", "it", "its", "be",
  "have", "has", "had", "do", "does", "did", "not", "but", "or", "if", "we",
  "they", "i", "my", "me", "he", "she", "his", "her", "what", "when", "where",
  "how", "why", "who", "which", "from", "about", "just", "like", "can", "will",
  "would", "should", "could", "been", "more", "than", "then", "them", "there",
  "here", "out", "up", "so", "all", "any", "some", "now", "get", "got", "going",
]);

/** Word characters incl. Latin-1 accented letters, so accented tokens stay intact. */
const WORD_RE = /[a-zàâäãáåçèéêëíïîìñòóôöõùúûüýÿœæßA-Z]+/gi;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(WORD_RE) ?? []).filter((w) => w.length > 0);
}

export interface LanguageVerdict {
  /** True when we're confident the text is NOT English (and there's enough of it). */
  isNonEnglish: boolean;
  /** Short machine reason for the meta / skip_reason. */
  reason: string;
  /** The signals we counted, for logging/meta. */
  signals: {
    letters: number;
    nonEnglishChars: number;
    nonEnglishStopwords: number;
    englishStopwords: number;
  };
}

/**
 * Decide whether a post is non-English. Conservative by construction:
 *
 *  - Short text (< MIN_DETECT_CHARS letters) → never flagged (English).
 *  - Any English stopword present → never flagged (a real English signal wins;
 *    this absorbs code-switching and the odd accented loanword in English text).
 *  - Otherwise flag when there's a clear non-English signal: ≥1 non-English
 *    stopword, OR ≥2 distinct accented/non-English characters (a single stray
 *    accent — e.g. one "é" in "café" — is not enough on its own).
 */
export function detectLanguage(text: string): LanguageVerdict {
  const cleaned = stripNoise(text);
  const letters = (cleaned.match(/[a-zàâäãáåçèéêëíïîìñòóôöõùúûüýÿœæßA-Z]/gi) ?? []).length;
  const tokens = tokenize(cleaned);

  let englishStopwords = 0;
  let nonEnglishStopwords = 0;
  for (const tok of tokens) {
    if (ENGLISH_STOPWORDS.has(tok)) englishStopwords++;
    if (NON_ENGLISH_STOPWORDS.has(tok)) nonEnglishStopwords++;
  }
  const nonEnglishChars = countDistinctNonEnglishChars(cleaned);

  const signals = { letters, nonEnglishChars, nonEnglishStopwords, englishStopwords };

  // Too little text to be confident — treat as English (lenient).
  if (letters < MIN_DETECT_CHARS) {
    return { isNonEnglish: false, reason: "too_short", signals };
  }
  // A real English signal present → keep it (absorbs loanwords + code-switching).
  if (englishStopwords > 0) {
    return { isNonEnglish: false, reason: "english_signal", signals };
  }
  // Clear non-English signal: a non-English function word, or two+ distinct
  // accented/inverted-punctuation characters (one stray accent is not enough).
  if (nonEnglishStopwords > 0) {
    return { isNonEnglish: true, reason: "non_english_stopword", signals };
  }
  if (nonEnglishChars >= 2) {
    return { isNonEnglish: true, reason: "non_english_diacritics", signals };
  }
  // No decisive signal either way — keep it (lenient default).
  return { isNonEnglish: false, reason: "no_signal", signals };
}

/** Convenience: true when the post should be allowed through (English / ambiguous). */
export function isEnglish(text: string): boolean {
  return !detectLanguage(text).isNonEnglish;
}

/** Count DISTINCT non-English diacritic/punctuation characters in the text. */
function countDistinctNonEnglishChars(text: string): number {
  const seen = new Set<string>();
  for (const ch of text.toLowerCase()) {
    if (NON_ENGLISH_CHARS.test(ch)) seen.add(ch);
  }
  return seen.size;
}

/**
 * Strip URLs, @mentions, #hashtags, and emoji before language analysis — these
 * are language-neutral and would otherwise dilute the letter count or (for
 * hashtags) merge multi-word tokens. Leaves plain words and accents intact.
 */
function stripNoise(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[@#]\w+/g, " ")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, " ");
}

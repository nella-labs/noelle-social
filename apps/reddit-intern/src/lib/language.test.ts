import { describe, expect, it } from "vitest";
import { detectLanguage, isEnglish, MIN_DETECT_CHARS } from "./language.js";

describe("detectLanguage", () => {
  it("flags a French sentence as non-English", () => {
    const v = detectLanguage(
      "Nous avons lancé notre nouvelle application et les retours sont très positifs",
    );
    expect(v.isNonEnglish).toBe(true);
    expect(isEnglish("Nous avons lancé notre nouvelle application")).toBe(false);
  });

  it("flags a Spanish sentence as non-English", () => {
    const v = detectLanguage(
      "Estamos construyendo una herramienta para founders y está funcionando muy bien",
    );
    expect(v.isNonEnglish).toBe(true);
  });

  it("flags a German sentence as non-English", () => {
    const v = detectLanguage(
      "Wir haben unser Produkt heute gestartet und die Resonanz ist sehr gut",
    );
    expect(v.isNonEnglish).toBe(true);
  });

  it("flags a Portuguese sentence as non-English", () => {
    const v = detectLanguage(
      "Hoje lançamos o nosso produto e também recebemos muito feedback positivo",
    );
    expect(v.isNonEnglish).toBe(true);
  });

  it("flags a French sentence with no accents via stopwords", () => {
    // No diacritics at all — relies purely on the stopword balance.
    const v = detectLanguage("Pour les builders qui veulent des outils plus simples");
    expect(v.isNonEnglish).toBe(true);
    expect(v.reason).toBe("non_english_stopword");
  });

  it("keeps an English sentence", () => {
    const v = detectLanguage(
      "We just shipped our new feature and the feedback has been great so far",
    );
    expect(v.isNonEnglish).toBe(false);
    expect(isEnglish("We just shipped our new feature")).toBe(true);
  });

  it("keeps an English question", () => {
    expect(isEnglish("Any tips for postgres migrations? We keep losing context.")).toBe(true);
  });

  it("is lenient on very short text (treated as English)", () => {
    expect(isEnglish("gm")).toBe(true);
    expect(isEnglish("lol same")).toBe(true);
    expect(isEnglish("ship it")).toBe(true);
    expect(detectLanguage("oui").reason).toBe("too_short");
  });

  it("is lenient on emoji-only / link-only text", () => {
    expect(isEnglish("🚀🔥💯")).toBe(true);
    expect(isEnglish("https://example.com/launch")).toBe(true);
    expect(isEnglish("@someone 🚀")).toBe(true);
  });

  it("does not flag English with a single accented loanword (one stray accent)", () => {
    // "café" carries one accent but the sentence is clearly English (stopwords).
    expect(isEnglish("Grabbing coffee at the café before the launch demo today")).toBe(true);
    expect(isEnglish("Our roadmap is naïve about scaling but we are iterating fast")).toBe(true);
  });

  it("requires >=2 distinct non-English chars to flag on diacritics alone", () => {
    // A short accent-bearing fragment with no English/non-English stopword and
    // only one distinct accent is NOT flagged (lenient).
    const oneAccent = detectLanguage("xxxxxxxxxxxx café");
    expect(oneAccent.signals.nonEnglishChars).toBe(1);
    expect(oneAccent.isNonEnglish).toBe(false);
  });

  it("MIN_DETECT_CHARS is the leniency floor", () => {
    expect(MIN_DETECT_CHARS).toBeGreaterThan(0);
    // exactly at/under the floor with non-English content is still not flagged
    expect(isEnglish("très bien")).toBe(true); // < 12 letters
  });

  // Regression: English ICP titles that hit an English-ambiguous "non-English"
  // stopword (and carry no common English function word to rescue them) used to
  // be flagged non-English and TERMINALLY SKIPPED by the classifier. These are
  // exactly the r/startups / r/SaaS posts Orion most wants.
  it("keeps English posts that tokenize to a removed ambiguous token", () => {
    // "non-technical" → "non"; no english stopword present.
    expect(isEnglish("Non-technical cofounder wanted, equity split")).toBe(true);
    // "fare" (airfare), no english stopword.
    expect(isEnglish("Fare thee well, legacy billing stack")).toBe(true);
    // "est" as a standalone token (timezone / established).
    expect(isEnglish("Launch thread goes live 9AM EST sharp")).toBe(true);
    // "con" (pros/cons) + "plus".
    expect(isEnglish("Biggest con plus one upside, pricing tiers")).toBe(true);
    // "die" as an English verb.
    expect(isEnglish("Watching my side project slowly die, honest retro")).toBe(true);
  });

  it("still flags genuinely non-English text (multi-signal)", () => {
    expect(isEnglish("Nous avons lancé notre nouvelle application aujourd hui")).toBe(false);
    expect(isEnglish("Wir haben unser Produkt heute gestartet und sind sehr zufrieden")).toBe(false);
  });
});

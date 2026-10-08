// Voice utilities for the X drafter. Stripped down from openclaw — the vault-
// scanning anchor loader is gone (the drafter pulls anchors from Nella in
// Task 24). Only the lint + char counter survive because the drafter prompt
// + Outbound contract both need accurate t.co-aware character counts.

export interface LintViolation { rule: string; match: string; index: number }
export interface LintResult { ok: boolean; violations: LintViolation[] }

// Lightweight pattern lint. Catches obvious-bad output from any LLM:
// em-dash trios, lowercase "i", "as an AI", oversold hooks. Each violation is
// a non-fatal flag — the drafter logs them but still ships the draft.
export async function lint(text: string): Promise<LintResult> {
  const violations: LintViolation[] = [];
  const rules: { rule: string; pattern: RegExp }[] = [
    { rule: "em-dash-triplet", pattern: /—.*—.*—/g },
    { rule: "lowercase-i", pattern: /(?:^|\s)i(?=[\s,.!?])/g },
    { rule: "as-an-ai", pattern: /\bas an? AI\b/gi },
    { rule: "im-just-an-ai", pattern: /I['']m just an? AI/gi },
    { rule: "marketing-hook", pattern: /\b(in this thread|let me explain|here'?s why|the truth is)\b/gi },
  ];
  for (const r of rules) {
    let m: RegExpExecArray | null;
    while ((m = r.pattern.exec(text)) !== null) {
      violations.push({ rule: r.rule, match: m[0], index: m.index });
    }
  }
  return { ok: violations.length === 0, violations };
}

// Twitter/X char count rules: every URL coalesces to 23 chars on the wire.
// We approximate without round-tripping through twitter-text by detecting
// http(s) URLs and counting them as 23.
export async function charCountX(
  text: string,
): Promise<{ count: number; limit: number; isValid: boolean; urls: string[] }> {
  const limit = 280;
  const urlRe = /\bhttps?:\/\/\S+/g;
  const urls: string[] = [];
  const stripped = text.replace(urlRe, (u) => {
    urls.push(u);
    return "_".repeat(23);
  });
  const count = [...stripped].length; // graphemes-approx via code-point spread
  return { count, limit, isValid: count <= limit, urls };
}

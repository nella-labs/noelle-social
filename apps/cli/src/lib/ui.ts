/* Minimal console UI — no color deps, just consistent symbols. */
export const ui = {
  step: (m: string) => console.log(`\n▸ ${m}`),
  ok: (m: string) => console.log(`  ✓ ${m}`),
  warn: (m: string) => console.warn(`  ! ${m}`),
  err: (m: string) => console.error(`  ✗ ${m}`),
  info: (m: string) => console.log(`  · ${m}`),
  plain: (m = "") => console.log(m),
};

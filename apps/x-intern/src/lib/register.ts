// The X (Vega) register + post-energy logic now lives in @noelle/runtime/register,
// shared with the Reddit intern (single source of truth — the old per-app copies
// drifted, and Reddit's was a truncated copy missing post-register detection). This
// shim re-exports it so existing "../lib/register.js" imports keep resolving.
// Tests live in packages/runtime/src/register.test.ts.
export * from "@noelle/runtime/register";

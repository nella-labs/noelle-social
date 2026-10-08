// The per-person + feed-wide reply memory now lives in @noelle/runtime
// (priorReplies.ts), shared with the X intern (Vega) — the queries only touch
// noelle.approvals/drafts/leads, which are platform-agnostic, so keeping two
// copies would have been the same drift that bit register.ts. This shim
// re-exports it so existing "../lib/prior-replies-db.js" imports keep resolving.
// Tests live in packages/runtime/src/priorReplies.test.ts.
export * from "@noelle/runtime/prior-replies";

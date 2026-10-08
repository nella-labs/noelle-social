// The per-person + feed-wide reply memory now lives in @noelle/runtime
// (priorReplies.ts), shared with Lyra and Vega — the queries only touch
// noelle.approvals/drafts/leads, which are platform-agnostic. This file was a
// byte-identical fork; keeping it would have kept Orion off two fixes the shared
// module now carries (a blank author_id no longer matches every other author,
// and the feed-wide window orders by pure recency so pending approvals are not
// starved out by sent ones during a backlog). This shim re-exports it so
// existing "../lib/prior-replies-db.js" imports keep resolving.
// Tests live in packages/runtime/src/priorReplies.test.ts.
export * from "@noelle/runtime/prior-replies";

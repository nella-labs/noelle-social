// Moved to @noelle/runtime (see dmLadder.ts / dmLadderDb.ts) — the ladder models
// RELATIONSHIP STAGE, not a platform, so Lyra and Vega share one implementation.
// This shim re-exports it so existing "../lib/dm-ladder.js" imports keep resolving.
export * from "@noelle/runtime/dm-ladder";

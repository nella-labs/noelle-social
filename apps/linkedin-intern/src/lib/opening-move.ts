// Opening-move variety now lives in @noelle/runtime (openingMove.ts), shared with
// the X intern (Vega) — the moves are platform-agnostic, only the noun differs
// ("comment" on LinkedIn, "reply" on X), which renderOpeningMoveBlock takes as a
// parameter. This shim re-exports it so existing "../lib/opening-move.js"
// imports keep resolving. Tests live in packages/runtime/src/openingMove.test.ts.
export * from "@noelle/runtime/opening-move";

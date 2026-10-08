// The opening-move set now lives in @noelle/runtime/opening-move, shared with
// the X and LinkedIn interns (single source of truth). This shim re-exports it
// so existing "../lib/opening-move.js" imports keep resolving.
//
// It replaces a local COPY that had drifted. The copy's DETAIL move still read
// "point at one concrete detail from the post and what it actually implies",
// which is the version that predates the house-skeleton work: that phrasing is
// what taught the drafters to make a detail from the post the SUBJECT of a
// verdict ("the X line is the part that…"), the single most repeated shape in
// the whole product. Vega and Lyra were fixed; Orion silently was not, because
// his copy was never wired to the shared module.
//
// The shared version also takes an optional move POOL, which the drafter needs
// to filter out QUESTION for the shapes whose directive forbids one.
//
// Tests live in packages/runtime/src/openingMove.test.ts; the local
// opening-move.test.ts is kept as a resolution check on this shim.
export * from "@noelle/runtime/opening-move";

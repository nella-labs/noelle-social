// RESERVED PLACEHOLDER — no runtime code here yet.
//
// Lane INT-DB-0 reserved this module and its `@noelle/runtime/classifier-plumbing`
// subpath export up front so the later intern data-layer lanes can land file
// contents without every one of them editing packages/runtime/package.json and
// colliding in it.
//
// What lands here: the shared classifier ENGINE wiring around createClassifier,
// today copied three times as
// apps/{x,linkedin,reddit}-intern/src/lib/classifier-engine.ts.
//
// Scope correction: this header used to also claim lib/classifier-routing.ts. It
// must not. Model-handle resolution is reserved separately as ./classifier-routing
// (src/classifierRouting.ts) and is being extracted there. Two reserved subpaths
// cannot both own one routing decision — that is the duplication this whole
// effort removes, and leaving both is how ./codex became a dead export.
//
// Owned by the later lane that performs that extraction. Until then this file is
// deliberately empty: `export {}` only, so it is a module and compiles clean.

export {};

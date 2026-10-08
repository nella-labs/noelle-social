// RESERVED PLACEHOLDER — no runtime code here yet.
//
// Lane INT-DB-0 reserved this module and its `@noelle/runtime/intern-activation`
// subpath export up front so the later intern data-layer lanes can land file
// contents without every one of them editing packages/runtime/package.json and
// colliding in it.
//
// What lands here: the shared "which agent instances are active" layer that every
// worker tick starts from (active-instance listing, status/paused handling,
// per-agent routing overrides), today copied FOUR times as
// apps/{x,linkedin,reddit,video}-intern/src/lib/activation.ts. video-intern's is a
// trimmed variant of the same layer (ActiveInstance + the pending-harvest
// listing) and is imported by 8+ Nova files, so it counts.
//
// Owned by the later lane that performs that extraction. Until then this file is
// deliberately empty: `export {}` only, so it is a module and compiles clean.

export {};

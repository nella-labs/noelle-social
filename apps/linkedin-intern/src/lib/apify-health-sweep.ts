// The Apify token health sweep now lives in @noelle/runtime
// (apifyHealthSweep.ts) so more than one worker can host it — it probes the
// SHARED noelle.connections pool, and hosting it only here meant the pool went
// unprobed whenever Lyra's worker was down. This shim re-exports it so existing
// "../lib/apify-health-sweep.js" imports keep resolving.
// Tests live in packages/runtime/src/apifyHealthSweep.test.ts.
export * from "@noelle/runtime/apify-health-sweep";

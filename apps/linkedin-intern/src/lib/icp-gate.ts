// The ICP "right person" gate now lives in @noelle/runtime (icpGate.ts), shared
// with the X intern (Vega) — the matcher is platform-neutral, only the profile
// field differs (LinkedIn headline vs X bio) and what a MISSING field means.
// This shim re-exports it so existing "../lib/icp-gate.js" imports keep
// resolving. Tests live in packages/runtime/src/icpGate.test.ts.
export * from "@noelle/runtime/icp-gate";

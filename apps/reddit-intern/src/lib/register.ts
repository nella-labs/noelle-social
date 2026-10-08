// The Reddit (Orion) register + post-energy logic now lives in
// @noelle/runtime/register, shared with the X intern (single source of truth). This
// replaces the old truncated copy that was missing post-register detection entirely
// — Orion now gets detectPostEnergy / pickRegisterForEnergy for free. This shim
// re-exports the shared module so existing "../lib/register.js" imports keep
// resolving. Tests live in packages/runtime/src/register.test.ts.
export * from "@noelle/runtime/register";

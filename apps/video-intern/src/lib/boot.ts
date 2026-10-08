// Re-export shim — boot checks + the exit-code taxonomy (78 config /
// 75 transient) live in @noelle/worker-runtime.
export {
  EX_OK,
  EX_CONFIG,
  EX_TEMPFAIL,
  runBootChecks,
  type BootCheck,
  type BootCheckKind,
  type BootResult,
} from "@noelle/worker-runtime";

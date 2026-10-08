// The operator's voice spec now lives in @noelle/runtime (voiceSpec.ts), shared
// with the X intern — it describes the OPERATOR's voice, which is one voice
// across every platform, so both interns read the same vault file.
// This shim re-exports it so existing "../lib/voice-spec.js" imports resolve.
export * from "@noelle/runtime/voice-spec";

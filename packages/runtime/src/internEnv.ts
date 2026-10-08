// RESERVED PLACEHOLDER — no runtime code here yet.
//
// Lane INT-DB-0 reserved this module and its `@noelle/runtime/intern-env`
// subpath export up front so the later intern data-layer lanes can land file
// contents without every one of them editing packages/runtime/package.json and
// colliding in it.
//
// What lands here: the shared intern worker env layer — the Zod-parsed non-secret
// runtime config in apps/{x,linkedin,reddit,video}-intern/src/env.ts — FOUR
// copies, video-intern's own header saying it mirrors linkedin-intern's — plus the
// ~/.noelle/.env loader used by the on-demand one-shots
// (apps/linkedin-intern/src/lib/dotenv.ts), whose quoting contract must stay
// byte-compatible with apps/cli/src/lib/env-writer.ts.
//
// Owned by the later lane that performs that extraction. Until then this file is
// deliberately empty: `export {}` only, so it is a module and compiles clean.

export {};

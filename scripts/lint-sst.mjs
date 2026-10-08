#!/usr/bin/env node
// Single-source-of-truth lint (D37).
//
// WHAT THIS WILL CHECK (once implemented):
//   - Walk `apps/`, `packages/`, and `infra/`.
//   - Collect every script file basename (*.mjs, *.ts, *.sh, *.py, *.sql migration name, *.yaml n8n flow, etc.).
//   - Fail if the same basename appears in more than one workspace location, unless
//     explicitly allow-listed in a top-of-repo `.sst-allow.json`.
//   - Goal: enforce CLAUDE.md rule that every script / flow / config exists in exactly
//     one place in this repo. No silent duplication between apps/api-vm and infra/, etc.
//
// CURRENT STATUS: placeholder. Exits 0 so CI scaffolding can wire it up without breaking.

console.log("single-source-of-truth lint placeholder — will be implemented");
process.exit(0);

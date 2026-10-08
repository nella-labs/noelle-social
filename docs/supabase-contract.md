# Shared outbound contract

`@noelle/contracts` defines the request and response schemas shared by Noelle services. The source schemas in `packages/contracts/src` are authoritative.

## Reply review

`POST /api/outbound` accepts `drafts[].verifierMeta` for the verdict on that exact reply body. It takes precedence over the older lead-level `verifierMeta`. Each verdict records `pass`, dimension scores, reasons, attempts, and optional `judgeOk` and `judgeProvider`.

The API stores the selected verdict in `drafts.payload.verifier_meta`. A pending reply can be sent unattended only when its own verdict has `pass: true` and `judgeOk: true`, along with the actor's existing voice and send controls. A failed or missing verdict remains visible in the approval inbox for review. DM approvals have a separate path and do not occupy browser-discovery reply slots.

## Recheck pending replies

After deploying a verifier change, run `pnpm --filter @noelle/api-vm exec tsx src/scripts/recheck-pending-replies.ts --org-id <uuid>`. The command loads `~/.noelle/.env` before importing the model runtime, so a direct invocation uses the same local model and budget flags as the workers. Explicit shell variables take precedence. Set `NOELLE_ENV_FILE` to use another generated env file; if no file exists, provide `NOELLE_DATABASE_URL` and a Jev credential in the environment. The command rechecks each pending X or LinkedIn reply's effective body in place. Jev runs first. A clear Jev failure rejects the reply even when another dimension is uncertain. Otherwise the writer's configured judge fills only uncertain or unavailable dimensions: LinkedIn's Haiku route, or X's instance drafter route (Haiku when `NOELLE_DRAFTER_VERIFY_CHEAP` is enabled). The shared runtime preserves the configured Codex primary, per-organization backend choice, spend recording, and budget caps. The command updates only the draft's verdict after a real judge response. A body hash, tenant scope, pending/unsent checks, and an unchanged-body database guard make reruns safe.

Rows with images but no saved caption are left for human review because the stored context is incomplete. A failed judge attempt remains eligible for a later retry. A real rejected verdict stays in the inbox and does not consume one of the browser actor's five reply slots.

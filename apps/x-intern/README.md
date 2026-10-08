# @noelle/x-intern

The X Growth Intern worker pool. Runs on `noelle-vm-0` under systemd as four
template units: `noelle-discovery@`, `noelle-classifier@`, `noelle-drafter@`,
`noelle-send@`.

Entrypoints are in `src/workers/`. Shared libs in `src/lib/`. Each worker is
launched by `run.sh <kind>`.

See `docs/runbook.md` § 3.4 for install + operate. See [the platform guide](../../docs/social-growth.md) for the current workflow.

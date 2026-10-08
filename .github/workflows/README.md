# Validation and deployment workflows

`ci.yml` runs one job with a 20-minute limit. It installs the frozen pnpm
lockfile, then runs typecheck, lint, build, and tests through Turbo. Tests are a
required part of that job. `pnpm lint:sst` runs separately in the same job.

Pull requests validate affected workspaces and their dependents. Pushes to
`main`, the public release branch, and manual runs validate the full workspace. Draft pull requests skip
this job. Superseded validation runs are cancelled.

- `ci.yml` validates the workspace on pull requests, pushes to `main` or `codex/public-release`, and manual runs.
- `agents-vm-deploy.yml` deploys the legacy GCP VM for selected paths on `main` or a manual ref. Internal health and worker checks gate success. The public probe is informational.
- `supabase-deploy.yml` deploys changed legacy migrations or the sync function for Supabase path changes on `main` or a manual target.

Native installations update through the managed `noelle sync` command.
Legacy deployment workflows start disabled. Set `NOELLE_ENABLE_LEGACY_VM_DEPLOY=true`
or `NOELLE_ENABLE_SUPABASE_DEPLOY=true` in repository Actions variables only after
configuring the corresponding infrastructure and secrets. The VM deploy script
uses the checkout's existing origin, or `NOELLE_REPOSITORY_URL` for an explicit
source URL. A fresh checkout defaults to the public source repository. See
[the runbook](../../docs/runbook.md) for runtime operation and
[the testing guide](../../docs/testing.md) for local validation.

Branch protection should use the current job name, `ci / ci`. Hosted workflow
availability depends on the repository's Actions configuration and billing;
local validation remains available through `pnpm ci:full`.

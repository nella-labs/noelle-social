#!/usr/bin/env bash
# The API now ships through the managed runtime deployment path.
set -euo pipefail
printf '%s\n' \
  'This API-only VM uploader is retired.' \
  'Run noelle sync for the managed runtime. See docs/architecture.md.' \
  'For legacy cloud rollback, see infra/agents-vm/deploy.sh and docs/runbook.md.' >&2
exit 1

#!/usr/bin/env bash
# Shared resource definitions for the cost scripts. Single source of truth for
# which managed resources the pause/resume/status scripts act on, so the three
# scripts can never drift on names/zones.
set -euo pipefail

PROJECT="noelle-agents"

# Compute Engine VMs: "name:zone"
VMS=(
  "noelle-vm-0:us-east1-c"
  "noelle-listmonk:us-central1-a"
)

# Cloud SQL instances (region-less in the CLI)
SQL_INSTANCES=(
  "noelle-db"
)

require_gcloud() {
  command -v gcloud >/dev/null 2>&1 || { echo "gcloud not found on PATH" >&2; exit 1; }
}

#!/usr/bin/env bash
# Pause the managed GCP footprint to ~$0. REVERSIBLE — stops compute, deletes
# nothing. Data on the VM disks + Cloud SQL survives; resume-managed.sh restores
# full service. AI (Vertex, pay-per-use) is untouched.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_resources.sh
source "$HERE/_resources.sh"
require_gcloud

echo "Pausing managed footprint in $PROJECT (reversible, no deletes)…"

for entry in "${VMS[@]}"; do
  name="${entry%%:*}"; zone="${entry##*:}"
  echo "  stopping VM $name ($zone)…"
  gcloud compute instances stop "$name" --zone "$zone" --project "$PROJECT" --quiet
done

for inst in "${SQL_INSTANCES[@]}"; do
  # activation-policy NEVER is the documented way to stop a Cloud SQL instance;
  # it stops the (billed) compute. Storage + automated backups remain.
  echo "  stopping Cloud SQL $inst (activation-policy NEVER)…"
  gcloud sql instances patch "$inst" --activation-policy NEVER --project "$PROJECT" --quiet
done

echo
echo "Done. Run infra/cost/status.sh to confirm, resume-managed.sh to bring back."

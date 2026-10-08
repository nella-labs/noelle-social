#!/usr/bin/env bash
# Bring the managed GCP footprint back online (inverse of pause-managed.sh).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_resources.sh
source "$HERE/_resources.sh"
require_gcloud

echo "Resuming managed footprint in $PROJECT…"

for inst in "${SQL_INSTANCES[@]}"; do
  echo "  starting Cloud SQL $inst (activation-policy ALWAYS)…"
  gcloud sql instances patch "$inst" --activation-policy ALWAYS --project "$PROJECT" --quiet
done

for entry in "${VMS[@]}"; do
  name="${entry%%:*}"; zone="${entry##*:}"
  echo "  starting VM $name ($zone)…"
  gcloud compute instances start "$name" --zone "$zone" --project "$PROJECT" --quiet
done

echo
echo "Done. Run infra/cost/status.sh to confirm. (Cloud SQL takes a minute to accept connections.)"

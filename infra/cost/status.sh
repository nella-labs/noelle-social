#!/usr/bin/env bash
# Show the running/stopped state of the managed GCP footprint (read-only).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_resources.sh
source "$HERE/_resources.sh"
require_gcloud

echo "Managed GCP footprint (project: $PROJECT)"
echo
echo "Compute Engine:"
for entry in "${VMS[@]}"; do
  name="${entry%%:*}"; zone="${entry##*:}"
  status=$(gcloud compute instances describe "$name" --zone "$zone" --project "$PROJECT" \
    --format="value(status)" 2>/dev/null || echo "NOT_FOUND")
  printf "  %-18s %s (%s)\n" "$name" "$status" "$zone"
done
echo
echo "Cloud SQL:"
for inst in "${SQL_INSTANCES[@]}"; do
  read -r state policy < <(gcloud sql instances describe "$inst" --project "$PROJECT" \
    --format="value(state, settings.activationPolicy)" 2>/dev/null || echo "NOT_FOUND -")
  printf "  %-18s state=%s activation=%s\n" "$inst" "$state" "$policy"
done

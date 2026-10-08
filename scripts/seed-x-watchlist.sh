#!/usr/bin/env bash
# Seeds noelle.x_watchlist with a default set of X handles for the given
# x_intern agent instance. Idempotent (ON CONFLICT DO NOTHING).
#
# Usage:
#   scripts/seed-x-watchlist.sh <org_id> <agent_instance_id>
#   scripts/seed-x-watchlist.sh --auto   # finds the only x_intern instance and seeds it
#
# Reads NOELLE_DATABASE_URL from /etc/noelle/api-vm.env on the VM. When run
# from a local dev box, set NOELLE_DATABASE_URL in your environment first.

set -euo pipefail

DEFAULT_HANDLES=(
  swyx
  jxnlco
  simonw
  levelsio
  rauchg
)

if [[ -z "${NOELLE_DATABASE_URL:-}" ]]; then
  if [[ -r /etc/noelle/api-vm.env ]]; then
    NOELLE_DATABASE_URL="$(sudo cat /etc/noelle/api-vm.env | awk -F= '/^NOELLE_DATABASE_URL=/{ sub(/^[^=]*=/,""); print; exit }')"
  fi
fi
if [[ -z "${NOELLE_DATABASE_URL:-}" ]]; then
  echo "NOELLE_DATABASE_URL not set and /etc/noelle/api-vm.env unreadable" >&2
  exit 64
fi

if [[ "${1:-}" == "--auto" ]]; then
  read -r ORG_ID AGENT_INSTANCE_ID < <(psql "$NOELLE_DATABASE_URL" -At -F" " -c "
    select org_id, id from noelle.agent_instances
    where role = 'x_intern' order by created_at asc limit 1
  ")
  if [[ -z "${ORG_ID:-}" ]]; then
    echo "no x_intern agent_instance found" >&2
    exit 65
  fi
  echo "auto-selected x_intern instance $AGENT_INSTANCE_ID in org $ORG_ID"
else
  ORG_ID="${1:?usage: seed-x-watchlist.sh <org_id> <agent_instance_id>  |  --auto}"
  AGENT_INSTANCE_ID="${2:?usage: seed-x-watchlist.sh <org_id> <agent_instance_id>}"
fi

VALUES=""
for h in "${DEFAULT_HANDLES[@]}"; do
  VALUES+="('${ORG_ID}','${AGENT_INSTANCE_ID}','handle','${h}'),"
done
VALUES="${VALUES%,}"

psql "$NOELLE_DATABASE_URL" -c "
  insert into noelle.x_watchlist (org_id, agent_instance_id, kind, value) values
    ${VALUES}
  on conflict (agent_instance_id, kind, value) do nothing
  returning value;
"

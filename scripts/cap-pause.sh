#!/usr/bin/env bash
# Lift the LLM budget cap for a while, or put it back.
#
# The cap is a hard gate: a BudgetExceededError stops the worker mid-tick. That
# is what stops a runaway. But sometimes the agents need to keep going past it,
# and the alternative — editing budget_cap_cents — relies on remembering to
# undo it. Every pause here carries an expiry, so it undoes itself.
#
#   scripts/cap-pause.sh today    lift until midnight tonight (America/Bogota)
#   scripts/cap-pause.sh week     lift until the end of Sunday
#   scripts/cap-pause.sh off      enforce again, now
#   scripts/cap-pause.sh status   show the pause, the spend and the cap
set -uo pipefail

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }

ENVFILE="${NOELLE_ENV_FILE:-$HOME/.noelle/.env}"
DB="$(grep -E '^NOELLE_DATABASE_URL=' "$ENVFILE" 2>/dev/null | head -1 | cut -d= -f2-)"
[ -n "$DB" ] || { echo "cap-pause: no NOELLE_DATABASE_URL in $ENVFILE" >&2; exit 2; }
ORG="${NOELLE_MCP_ORG:-${NOELLE_ORG_SLUG:-}}"
if [ -z "$ORG" ]; then
  ORG="$(sed -n 's/^NOELLE_MCP_ORG=//p' "$ENVFILE" | head -1)"
fi
if [ -z "$ORG" ]; then
  CONFIG="${NOELLE_HOME:-$HOME/.noelle}/config.json"
  ORG="$(node -e 'try { process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).org?.slug || ""); } catch {}' "$CONFIG")"
fi
[[ "$ORG" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "cap-pause: configure a valid NOELLE_MCP_ORG or installation workspace" >&2; exit 2; }

# Local wall-clock boundaries, so "today" means the operator's today.
TZ_NAME="America/Bogota"

set_until() { # <sql expression yielding timestamptz or NULL> <human label>
  psql "$DB" -q -c "update noelle.organizations set budget_cap_paused_until = $1 where slug = '$ORG'" || exit 1
  echo "cap $2"
  status
}

status() {
  psql "$DB" -X -q -c "
    select o.slug,
           coalesce(to_char(o.budget_cap_paused_until at time zone '$TZ_NAME', 'YYYY-MM-DD HH24:MI'), '-') as paused_until,
           case when o.budget_cap_paused_until > now() then 'LIFTED' else 'enforced' end as state,
           (select coalesce(sum(budget_cap_cents),0)/100.0 from noelle.agent_instances where org_id = o.id) as cap_usd,
           (select coalesce(sum(cents),0)/100.0 from noelle.llm_calls
              where org_id = o.id and engine <> all('{apify,xapi}'::text[])
                and started_at >= date_trunc('week', now())) as spent_this_week_usd
    from noelle.organizations o where o.slug = '$ORG'"
}

case "${1:-status}" in
  today)
    set_until "(date_trunc('day', now() at time zone '$TZ_NAME') + interval '1 day') at time zone '$TZ_NAME'" \
              "lifted until midnight tonight"
    ;;
  week)
    # date_trunc('week') is Monday; +7d lands on next Monday 00:00, i.e. the end
    # of Sunday — the same boundary the weekly spend window resets on.
    set_until "(date_trunc('week', now() at time zone '$TZ_NAME') + interval '7 days') at time zone '$TZ_NAME'" \
              "lifted until the end of Sunday"
    ;;
  off)   set_until "null" "enforced again" ;;
  status) status ;;
  -h|--help) usage ;;
  *) echo "cap-pause: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
esac

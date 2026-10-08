#!/usr/bin/env bash
# Seeds noelle.video_watchlist_sources + noelle.video_watchlist_niches with a
# starter set of TikTok creators + niche lanes for a Nova (video_intern) instance.
# This is the "turn TikTok on" data step from docs/content-studio.md ("Activating
# TikTok"). The transport (packages/video-apify, clockworks~tiktok-scraper) and
# the harvester lanes are already TikTok-ready — this only inserts rows.
#
# ⚠️  DANGER: this writes to PRODUCTION noelle.* and, on the next harvest tick,
#     causes the Nova harvester to make PAID Apify TikTok scrapes for every row
#     it inserts. It does NOT read /etc/noelle/*.env by design — you must pass an
#     explicit connection string and acknowledge the cost.
#
# Usage:
#   DATABASE_URL='postgres://…' CONFIRM=1 scripts/seed-video-watchlist-tiktok.sh <org_id> <agent_instance_id>
#   DATABASE_URL='postgres://…' CONFIRM=1 scripts/seed-video-watchlist-tiktok.sh --auto
#
# Optional overrides (space-separated; defaults below):
#   HANDLES='garyvee alexhormozi …'   TikTok creator handles (no @ needed)
#   NICHES='startup founder …'        niche keyword/hashtag lanes (no # needed)
#
# Idempotent: ON CONFLICT DO NOTHING on (agent_instance_id, platform, handle|query).

set -euo pipefail

warn() { printf '%s\n' "$@" >&2; }

# --- Starter seed data (override via env) ------------------------------------
# Handles are lowercased + de-@'d in SQL; niches are de-#'d + lowercased in SQL.
read -r -a TIKTOK_HANDLES <<<"${HANDLES:-garyvee alexhormozi thefutur noahkagan danmartell}"
# Multi-word niches: pass NICHES as a '|'-separated list to preserve spaces.
NICHES_DEFAULT='startup founder|build in public|founder story|marketing tips|content strategy'

# --- Loud warning ------------------------------------------------------------
warn "############################################################################"
warn "#  seed-video-watchlist-tiktok.sh                                           #"
warn "#  DANGER: seeds PRODUCTION noelle.* (video watchlist) and triggers PAID    #"
warn "#  Apify TikTok scrapes on the Nova harvester's NEXT tick, per seeded row.  #"
warn "#  This costs money. Point DATABASE_URL where you actually intend.          #"
warn "############################################################################"
warn ""

# --- Require an explicit connection string (no /etc/noelle fallback) ---------
if [[ -z "${DATABASE_URL:-}" ]]; then
  warn "DATABASE_URL is required — an explicit Postgres connection string."
  warn "By design this script does NOT read /etc/noelle/api-vm.env; you must point"
  warn "it at the DB yourself so a prod write is never accidental."
  exit 64
fi

# --- Require explicit acknowledgement ----------------------------------------
if [[ "${CONFIRM:-}" != "1" ]]; then
  warn "Refusing to run without CONFIRM=1. Re-run with CONFIRM=1 once you have"
  warn "verified DATABASE_URL points where you intend and accept the Apify cost."
  exit 3
fi

command -v psql >/dev/null 2>&1 || { warn "psql not found on PATH"; exit 127; }

# --- Resolve the target instance --------------------------------------------
if [[ "${1:-}" == "--auto" ]]; then
  read -r ORG_ID AGENT_INSTANCE_ID < <(psql "$DATABASE_URL" -At -F" " -c "
    select org_id, id from noelle.agent_instances
    where role = 'video_intern' order by created_at asc limit 1
  ")
  if [[ -z "${ORG_ID:-}" ]]; then
    warn "no video_intern agent_instance found in the target DB"
    exit 65
  fi
  warn "auto-selected video_intern instance $AGENT_INSTANCE_ID in org $ORG_ID"
else
  ORG_ID="${1:?usage: DATABASE_URL=… CONFIRM=1 seed-video-watchlist-tiktok.sh <org_id> <agent_instance_id>  |  --auto}"
  AGENT_INSTANCE_ID="${2:?usage: DATABASE_URL=… CONFIRM=1 seed-video-watchlist-tiktok.sh <org_id> <agent_instance_id>}"
fi

# '|'-join the handle array so string_to_array can split it back in SQL.
HANDLES_STR="$(IFS='|'; printf '%s' "${TIKTOK_HANDLES[*]}")"
NICHES_STR="${NICHES:-$NICHES_DEFAULT}"

# --- Parameterized insert (psql :'var' substitution quotes every value) ------
psql "$DATABASE_URL" \
  --set=ON_ERROR_STOP=1 \
  --set=org="$ORG_ID" \
  --set=inst="$AGENT_INSTANCE_ID" \
  --set=handles="$HANDLES_STR" \
  --set=niches="$NICHES_STR" <<'SQL'
\echo 'Seeding noelle.video_watchlist_sources (platform=tiktok)…'
insert into noelle.video_watchlist_sources (org_id, agent_instance_id, platform, handle, enabled)
select :'org'::uuid, :'inst'::uuid, 'tiktok', lower(ltrim(btrim(h), '@')), true
from unnest(string_to_array(:'handles', '|')) as h
where btrim(h) <> ''
on conflict (agent_instance_id, platform, handle) do nothing
returning handle;

\echo 'Seeding noelle.video_watchlist_niches (platform=tiktok)…'
insert into noelle.video_watchlist_niches (org_id, agent_instance_id, platform, query, enabled)
select :'org'::uuid, :'inst'::uuid, 'tiktok', lower(ltrim(btrim(q), '#')), true
from unnest(string_to_array(:'niches', '|')) as q
where btrim(q) <> ''
on conflict (agent_instance_id, platform, query) do nothing
returning query;
SQL

warn ""
warn "Done. TikTok rows seeded for instance $AGENT_INSTANCE_ID."
warn "They will be scraped (PAID) on the next Nova harvest tick."

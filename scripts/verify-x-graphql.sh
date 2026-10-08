#!/usr/bin/env bash
# Use the same retirement boundary as the former pinned-ID updater.
set -euo pipefail
exec bash "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/update-x-graphql-ids.sh" "$@"

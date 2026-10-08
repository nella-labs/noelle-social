#!/usr/bin/env bash
# Pinned query IDs have been replaced by the shared X transport.
set -euo pipefail
printf '%s\n' \
  'This pinned X GraphQL maintenance command is retired.' \
  'Current workers do not use manually maintained query ID constants.' \
  'See docs/x-graphql-capture.md for supported X transport diagnostics.' >&2
exit 1

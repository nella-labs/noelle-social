#!/usr/bin/env bash
# Shared local and GitHub CI gate.
set -uo pipefail

usage() {
  cat <<'USAGE'
Local CI — the gate .github/workflows/ci.yml runs, on this machine.

Usage: scripts/ci-local.sh [options]

  --full           validate everything (used for pushes and manual CI runs)
  --affected       validate only what changed vs the base ref (default on a branch)
  --base <ref>     comparison point for --affected (default: origin/main)
  --skip-install   reuse node_modules as-is, skip `pnpm install`
  --pre-push       quiet mode used by the git hook; prints output only on failure
  -h, --help       this text

GitHub uses affected scope for pull requests and full scope for pushes and manual
runs. Exit code is the failing step's, 0 when everything passes.
USAGE
}

MODE=affected
BASE=origin/main
DO_INSTALL=1
QUIET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --full) MODE=full; shift ;;
    --affected) MODE=affected; shift ;;
    --base) BASE="${2:?--base needs a ref}"; shift 2 ;;
    --skip-install) DO_INSTALL=0; shift ;;
    --pre-push) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ci-local: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

# Hooks run with GIT_DIR pointing at the pushing worktree; scrub it so the git
# calls below resolve against the checkout we cd into, not an inherited one.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ci-local: not inside a git repository" >&2; exit 2
}
cd "$ROOT" || exit 2

bold=""; red=""; green=""; yellow=""; reset=""
if [ -t 1 ]; then
  bold=$'\033[1m'; red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; reset=$'\033[0m'
fi
say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }

# Private temp dir: the step log is written with `>`, and a predictable path in
# a world-writable /tmp is a symlink-truncation target. Trapped so an interrupt
# does not leave it behind.
TMPDIR_CI="$(mktemp -d "${TMPDIR:-/tmp}/ci-local.XXXXXX")" || exit 2
trap 'rm -rf "$TMPDIR_CI"' EXIT HUP INT TERM

# --- version drift -----------------------------------------------------------
# "Works on my machine" usually means a different Node. Warn, never block: the
# workflow pins these, so a mismatch makes a local pass less meaningful.
want_node="$(tr -dc '0-9.' < .nvmrc 2>/dev/null)"
have_node="$(node -v 2>/dev/null | tr -dc '0-9.')"
if [ -n "$want_node" ] && [ "${have_node%%.*}" != "${want_node%%.*}" ]; then
  say "${yellow}warn${reset} node ${have_node:-none} but .nvmrc pins ${want_node}"
fi
want_pnpm="$(sed -n 's/.*PNPM_VERSION: "\([^"]*\)".*/\1/p' .github/workflows/ci.yml 2>/dev/null | head -1)"
have_pnpm="$(pnpm --version 2>/dev/null)"
if [ -n "$want_pnpm" ] && [ -n "$have_pnpm" ] && [ "$have_pnpm" != "$want_pnpm" ]; then
  say "${yellow}warn${reset} pnpm ${have_pnpm} but ci.yml pins ${want_pnpm}"
fi

# --- scope -------------------------------------------------------------------
# Local checks on main retain full validation even when affected scope is requested.
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ "$MODE" = affected ] && [ "$BRANCH" = "main" ]; then
  say "${yellow}note${reset} on main — validating everything, as the workflow does"
  MODE=full
fi

AFFECTED=""
if [ "$MODE" = affected ]; then
  if git rev-parse --verify --quiet "$BASE" >/dev/null; then
    merge_base="$(git merge-base "$BASE" HEAD 2>/dev/null)"
    head_sha="$(git rev-parse HEAD 2>/dev/null)"
    if [ -n "$merge_base" ] && [ "$merge_base" != "$head_sha" ]; then
      AFFECTED="--affected"
      export TURBO_SCM_BASE="$merge_base"
    else
      say "${yellow}note${reset} no commits ahead of ${BASE}; validating everything"
    fi
  else
    say "${yellow}note${reset} ${BASE} not found; validating everything"
  fi
fi

# --- run ---------------------------------------------------------------------
started=$(date +%s)

step() { # <name> <command...>
  local name="$1"; shift
  local t0 rc dt
  t0=$(date +%s)
  say "${bold}▸ ${name}${reset}"
  if [ "$QUIET" = 1 ]; then
    "$@" >"$TMPDIR_CI/step.log" 2>&1; rc=$?
    [ $rc -eq 0 ] || tail -40 "$TMPDIR_CI/step.log"
  else
    "$@"; rc=$?
  fi
  dt=$(( $(date +%s) - t0 ))
  if [ $rc -eq 0 ]; then
    say "  ${green}pass${reset} ${name} (${dt}s)"
  else
    say "  ${red}FAIL${reset} ${name} (${dt}s, exit ${rc})"
    say "${red}${bold}ci-local FAILED${reset} at: ${name}"
  fi
  return $rc
}

if [ "$DO_INSTALL" = 1 ]; then
  step "install" pnpm install --frozen-lockfile || exit $?
fi

# One turbo invocation so build outputs are computed once and reused, exactly as
# the workflow does. Two concurrent tasks bound competing build and test processes.
# Workspaces without tests pass via `vitest run --passWithNoTests`.
# shellcheck disable=SC2086
step "typecheck + lint + build + test" pnpm exec turbo run typecheck lint build test --concurrency=2 $AFFECTED || exit $?

# Repo-wide single-source-of-truth check. Not a turbo task, so it always runs
# regardless of --affected.
step "lint:sst" pnpm lint:sst || exit $?

# Repo-wide reply guard, independent of affected workspace scope.
step "lint:reply-variation" pnpm lint:reply-variation || exit $?

# The suite covering this script and its hook wiring. `scripts/` is not a pnpm
# workspace, so turbo never sees it — without this line the tests guarding the
# gate are the one thing the gate does not run.
if [ -x scripts/ci-local.test.sh ]; then
  step "ci-local self-test" bash scripts/ci-local.test.sh || exit $?
fi

total=$(( $(date +%s) - started ))
say "${green}${bold}ci-local passed${reset} (${total}s${AFFECTED:+, affected only})"

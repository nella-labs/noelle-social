#!/usr/bin/env bash
# Install the versioned git hooks in scripts/githooks/ as thin shims.
#
# Deliberately does NOT set core.hooksPath. This repo already has a
# `noelle autoupdate install`-generated post-commit living in the active hooks
# directory, and repointing core.hooksPath would silently stop it — which is the
# hook that deploys. Instead we drop a shim next to it, so both survive.
#
#   scripts/install-githooks.sh          install (refuses to clobber a foreign hook)
#   scripts/install-githooks.sh --force  overwrite whatever is there
#   scripts/install-githooks.sh --check  report status, change nothing (exit 1 if missing)
set -uo pipefail

usage() {
  cat <<'USAGE'
Install the versioned git hooks in scripts/githooks/ as thin shims.

Usage: scripts/install-githooks.sh [options]

  --force   overwrite a hook this script did not write
  --check   report status, change nothing (exit 1 if missing or not executable)
  -h, --help  this text

Deliberately does NOT set core.hooksPath: the `noelle autoupdate install`
post-commit lives in the active hooks directory, and repointing would silently
stop deploys.
USAGE
}

FORCE=0; CHECK=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --check) CHECK=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install-githooks: unknown argument '$a'" >&2; usage >&2; exit 2 ;;
  esac
done

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not a git repo" >&2; exit 2; }
cd "$ROOT" || exit 2

# Honours core.hooksPath if it is set, so the shim lands wherever git will
# actually look for it.
HOOKS="$(git rev-parse --git-path hooks 2>/dev/null)"
[ -n "$HOOKS" ] || { echo "cannot resolve hooks dir" >&2; exit 2; }
mkdir -p "$HOOKS"

MARKER="noelle-managed shim -> scripts/githooks"
rc=0
found=0

for name in pre-push; do
  src="scripts/githooks/$name"
  dst="$HOOKS/$name"
  # Say so rather than exiting 0 having done nothing: a checkout that predates
  # local CI (or main, before this lands) has no scripts/githooks, and a silent
  # no-op reads exactly like a successful install.
  if [ ! -f "$src" ]; then
    echo "no $src in $(pwd) — run this from a checkout that has it" >&2
    rc=1
    continue
  fi
  found=$((found + 1))

  if [ "$CHECK" = 1 ]; then
    # -x matters as much as the marker: git silently skips a hook that is not
    # executable, so reporting "ok" for one would be reporting a gate that
    # never runs.
    if [ ! -f "$dst" ] || ! grep -q "$MARKER" "$dst" 2>/dev/null; then
      echo "MISSING    $name (run scripts/install-githooks.sh)"; rc=1
    elif [ ! -x "$dst" ]; then
      echo "NOT EXEC   $name -> $dst (git will skip it; re-run the installer)"; rc=1
    else
      echo "ok         $name -> $dst"
    fi
    continue
  fi

  if [ -f "$dst" ] && ! grep -q "$MARKER" "$dst" 2>/dev/null && [ "$FORCE" != 1 ]; then
    echo "refusing to overwrite existing $dst (not ours). Re-run with --force." >&2
    rc=1
    continue
  fi

  cat > "$dst" <<SHIM
#!/usr/bin/env bash
# $MARKER/$name — do not edit; edit the versioned script instead.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
top="\$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -x "\$top/scripts/githooks/$name" ] || exit 0
exec "\$top/scripts/githooks/$name" "\$@"
SHIM
  chmod +x "$dst"
  echo "installed $name -> $dst"
done

[ "$found" -gt 0 ] || echo "installed nothing" >&2
exit $rc

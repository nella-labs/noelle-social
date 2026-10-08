#!/usr/bin/env bash
# Table test for the local CI entrypoint and its hook wiring.
#
# Covers the parts that must hold without paying for a full turbo run: argument
# handling, the pre-push escape hatch and its old-branch no-op, and the
# installer's refusal to clobber a hook it did not write (the post-commit that
# `noelle autoupdate install` generates lives in the same directory, and losing
# it would silently stop deploys).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
fail=0

ok()   { echo "ok: $1"; }
bad()  { echo "FAIL: $1"; fail=1; }
check() { # <desc> <expected-rc> <actual-rc>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (wanted rc=$2, got rc=$3)"; fi
}

# --- ci-local.sh argument handling -------------------------------------------
"$HERE/ci-local.sh" --help >/dev/null 2>&1
check "--help exits 0" 0 $?

"$HERE/ci-local.sh" --nonsense >/dev/null 2>&1
check "unknown argument exits 2" 2 $?

out="$("$HERE/ci-local.sh" --help 2>&1)"
case "$out" in
  *"--full"*) ok "--help documents --full" ;;
  *) bad "--help does not document --full" ;;
esac
case "$out" in
  *"--pre-push"*) ok "--help documents --pre-push" ;;
  *) bad "--help does not document --pre-push" ;;
esac
# A sed line-range for help text drifts the moment the header changes; this
# caught it printing `set -uo pipefail` as documentation.
case "$out" in
  *"set -uo pipefail"*|*"MODE=affected"*) bad "--help leaks script source" ;;
  *) ok "--help prints no script source" ;;
esac

hout="$("$HERE/install-githooks.sh" --help 2>&1)"
case "$hout" in
  *"set -uo pipefail"*|*"FORCE=0"*) bad "installer --help leaks script source" ;;
  *) ok "installer --help prints no script source" ;;
esac

# --- a scratch repo so nothing below touches the real one --------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git -C "$TMP" init -q
git -C "$TMP" config user.email t@t.t
git -C "$TMP" config user.name t
# Keep the scratch repo independent of the operator's global core.hooksPath.
# The assertions below intentionally exercise this repo's own .git/hooks.
git -C "$TMP" config core.hooksPath "$TMP/.git/hooks"
mkdir -p "$TMP/scripts/githooks"
cp "$HERE/githooks/pre-push" "$TMP/scripts/githooks/pre-push"
cp "$HERE/install-githooks.sh" "$TMP/scripts/install-githooks.sh"
chmod +x "$TMP/scripts/githooks/pre-push" "$TMP/scripts/install-githooks.sh"
echo x > "$TMP/f"; git -C "$TMP" add -A; git -C "$TMP" commit -qm init

run_in_tmp() { ( cd "$TMP" && "$@" ); }

# --- installer ---------------------------------------------------------------
run_in_tmp ./scripts/install-githooks.sh --check >/dev/null 2>&1
check "--check reports missing before install" 1 $?

run_in_tmp ./scripts/install-githooks.sh >/dev/null 2>&1
check "install succeeds" 0 $?

[ -x "$TMP/.git/hooks/pre-push" ] && ok "pre-push shim is executable" || bad "pre-push shim missing"

run_in_tmp ./scripts/install-githooks.sh --check >/dev/null 2>&1
check "--check passes after install" 0 $?

run_in_tmp ./scripts/install-githooks.sh >/dev/null 2>&1
check "install is idempotent" 0 $?

# A hook we did not write must survive. This is the post-commit case.
printf '#!/bin/sh\necho theirs\n' > "$TMP/.git/hooks/pre-push"
chmod +x "$TMP/.git/hooks/pre-push"
run_in_tmp ./scripts/install-githooks.sh >/dev/null 2>&1
check "refuses to clobber a foreign hook" 1 $?
grep -q theirs "$TMP/.git/hooks/pre-push" && ok "foreign hook left intact" || bad "foreign hook was overwritten"

run_in_tmp ./scripts/install-githooks.sh --force >/dev/null 2>&1
check "--force overwrites" 0 $?

# A checkout without scripts/githooks (main, before this lands) must SAY so
# rather than exit 0 having installed nothing.
EMPTY="$(mktemp -d)"
git -C "$EMPTY" init -q
cp "$HERE/install-githooks.sh" "$EMPTY/install-githooks.sh"
( cd "$EMPTY" && bash ./install-githooks.sh >/dev/null 2>&1 )
check "reports a no-op when there are no versioned hooks" 1 $?
rm -rf "$EMPTY"

# --- pre-push ref handling ----------------------------------------------------
# git feeds the hook one line per ref: <local ref> <local sha> <remote ref> <remote sha>
ZERO="$(printf '0%.0s' $(seq 40))"
mk_ci_stub() { printf '#!/bin/sh\nexit %s\n' "$1" > "$TMP/scripts/ci-local.sh"; chmod +x "$TMP/scripts/ci-local.sh"; }

# A red tree must not block `git push --delete` — there is no tree to validate.
# Both widths, so the all-zero check cannot regress to a 40-char literal.
mk_ci_stub 3
ZERO64="$(printf '0%.0s' $(seq 64))"
echo "(delete) $ZERO64 refs/heads/gone $ZERO64" | run_in_tmp ./scripts/githooks/pre-push >/dev/null 2>&1
check "sha256-width deletion skips CI too" 0 $?
echo "(delete) $ZERO refs/heads/gone $ZERO" | run_in_tmp ./scripts/githooks/pre-push >/dev/null 2>&1
check "deletion skips CI even when CI would fail" 0 $?

echo "refs/tags/v1 $(git -C "$TMP" rev-parse HEAD) refs/tags/v1 $ZERO" \
  | run_in_tmp ./scripts/githooks/pre-push >/dev/null 2>&1
check "tag push skips CI" 0 $?

printf '' | run_in_tmp ./scripts/githooks/pre-push >/dev/null 2>&1
check "empty stdin skips CI" 0 $?

# Pushing a ref that is not the checked-out tree must not report a pass for a
# tree that was never examined.
echo "refs/heads/other 1111111111111111111111111111111111111111 refs/heads/other $ZERO" \
  | run_in_tmp ./scripts/githooks/pre-push >/dev/null 2>&1
check "refuses a ref that is not HEAD" 1 $?

# The normal case: pushing HEAD runs CI and honours its exit code.
mk_ci_stub 0
echo "refs/heads/main $(git -C "$TMP" rev-parse HEAD) refs/heads/main $ZERO" \
  | run_in_tmp ./scripts/githooks/pre-push >/dev/null 2>&1
check "pushing HEAD runs CI and passes" 0 $?

mk_ci_stub 3
echo "refs/heads/main $(git -C "$TMP" rev-parse HEAD) refs/heads/main $ZERO" \
  | run_in_tmp ./scripts/githooks/pre-push >/dev/null 2>&1
check "pushing HEAD propagates a CI failure" 3 $?
rm -f "$TMP/scripts/ci-local.sh"

# --- installer executability --------------------------------------------------
run_in_tmp ./scripts/install-githooks.sh --force >/dev/null 2>&1
chmod -x "$TMP/.git/hooks/pre-push"
run_in_tmp ./scripts/install-githooks.sh --check >/dev/null 2>&1
check "--check fails a non-executable hook git would skip" 1 $?
run_in_tmp ./scripts/install-githooks.sh --force >/dev/null 2>&1

# --- pre-push behaviour -------------------------------------------------------
# Every invocation below feeds stdin explicitly: the hook reads git's ref lines,
# so a test that leaves stdin attached to the terminal hangs forever.
PUSH_HEAD="refs/heads/main $(git -C "$TMP" rev-parse HEAD) refs/heads/main $ZERO"

echo "$PUSH_HEAD" | NOELLE_SKIP_CI=1 run_in_tmp ./scripts/githooks/pre-push >/dev/null 2>&1
check "NOELLE_SKIP_CI=1 short-circuits" 0 $?

# A branch cut before local CI existed has no ci-local.sh; the hook must not
# block a push on a repo that simply predates it.
echo "$PUSH_HEAD" | run_in_tmp ./scripts/githooks/pre-push >/dev/null 2>&1
check "no-ops when ci-local.sh is absent" 0 $?

# --- main never gets the weaker gate -----------------------------------------
# Local checks on main retain full validation when HEAD is ahead of the base.
# Stubbed pnpm records scope and task admission without running workspace tasks.
SCOPE="$(mktemp -d)"
git -C "$SCOPE" init -q -b main
git -C "$SCOPE" config user.email t@t.t; git -C "$SCOPE" config user.name t
mkdir -p "$SCOPE/scripts"
cp "$HERE/ci-local.sh" "$SCOPE/scripts/ci-local.sh"
mkdir -p "$SCOPE/bin"
cat > "$SCOPE/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = --version ]; then echo 10.28.0; exit 0; fi
printf '%s\n' "$*" >> "$CI_LOCAL_TEST_LOG"
if [ "${1:-}" = exec ] && [ "${2:-}" = turbo ]; then
  exit "${CI_LOCAL_TEST_TURBO_EXIT:-0}"
fi
STUB
chmod +x "$SCOPE/bin/pnpm"
scope_ci() {
  ( cd "$SCOPE" && PATH="$SCOPE/bin:$PATH" CI_LOCAL_TEST_LOG="$SCOPE/commands" \
    bash ./scripts/ci-local.sh "$@" )
}
echo a > "$SCOPE/a"; git -C "$SCOPE" add -A; git -C "$SCOPE" commit -qm one
# A second commit so HEAD is ahead of any base — the exact shape that used to
# select --affected.
echo b > "$SCOPE/b"; git -C "$SCOPE" add -A; git -C "$SCOPE" commit -qm two
git -C "$SCOPE" branch -f origin-main HEAD~1

scope_out="$(scope_ci --skip-install --base origin-main 2>&1)"
case "$scope_out" in
  *"on main"*) ok "main is validated in full, not --affected" ;;
  *) bad "main did not take the full-validation path" ;;
esac

git -C "$SCOPE" checkout -q -b feature
scope_out="$(scope_ci --skip-install --base origin-main 2>&1)"
case "$scope_out" in
  *"on main"*) bad "a feature branch took main's full-validation path" ;;
  *) ok "a branch still uses the affected path" ;;
esac

# Capture task admission without starting workspace tasks.
: > "$SCOPE/commands"
scope_ci --full --skip-install >/dev/null 2>&1
check "full gate succeeds with stubbed tools" 0 $?
if grep -Fxq 'exec turbo run typecheck lint build test --concurrency=2' "$SCOPE/commands"; then
  ok "full gate admits at most two workspace tasks"
else
  bad "full gate must bound workspace task admission to two"
fi
grep -Fxq 'lint:sst' "$SCOPE/commands" && ok "full gate retains lint:sst" || bad "full gate omitted lint:sst"
grep -Fxq 'lint:reply-variation' "$SCOPE/commands" && ok "full gate retains reply guard" || bad "full gate omitted reply guard"

: > "$SCOPE/commands"
scope_ci --affected --base origin-main --skip-install >/dev/null 2>&1
check "affected gate succeeds with stubbed tools" 0 $?
if grep -Fxq 'exec turbo run typecheck lint build test --concurrency=2 --affected' "$SCOPE/commands"; then
  ok "affected gate admits at most two workspace tasks"
else
  bad "affected gate must bound workspace task admission to two"
fi

: > "$SCOPE/commands"
CI_LOCAL_TEST_TURBO_EXIT=7 scope_ci --full --skip-install >/dev/null 2>&1
check "bounded task gate propagates failure" 7 $?
if grep -q '^lint:' "$SCOPE/commands"; then
  bad "repository guards ran after task gate failure"
else
  ok "task gate failure stops later steps"
fi
rm -rf "$SCOPE"

[ $fail -eq 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit $fail

#!/usr/bin/env bash
# Table test: feed realistic PreToolUse payloads (command, description, cwd),
# assert whether guidance fired. Payloads are built with jq so commands may
# carry quotes, escapes, and anything else a real session sends.
set -u
HOOK="$(dirname "$0")/guard-deploy.sh"
fail=0

check() { # <desc> <command> <expect-guidance:yes|no> [cwd] [description]
  local desc="$1" cmd="$2" want="$3" cwd="${4:-}" tdesc="${5:-}"
  local payload
  payload="$(jq -n --arg c "$cmd" --arg w "$cwd" --arg d "$tdesc" \
    '{tool_name:"Bash", tool_input:({command:$c} + (if $d=="" then {} else {description:$d} end))}
     + (if $w=="" then {} else {cwd:$w} end)')"
  local out rc
  out="$(printf '%s' "$payload" | bash "$HOOK" 2>&1)"; rc=$?
  local got=no
  printf '%s' "$out" | grep -q "Deploys are automatic" && got=yes
  if [ "$got" != "$want" ]; then
    echo "FAIL: $desc (wanted guidance=$want, got=$got, rc=$rc)"; fail=1
  else
    echo "ok: $desc"
  fi
}

MAIN=/Users/demooperator/Projects/noelle
WT=/Users/demooperator/Projects/noelle/.claude/worktrees/some-branch

# Sanctioned pipeline entrypoints (first-token anchored)
check "noelle sync is the sanctioned loop"  "noelle sync"           no
check "noelle deploy (manual kick)"         "noelle deploy"         no
check "sanctioned deploy --force"           "noelle deploy --force" no

# Compound commands cannot ride the sanction in either direction
check "block then sanctioned tail"          "pm2 delete noelle-app && noelle sync" yes
check "sanctioned head then block"          "noelle sync && pm2 delete noelle-app" yes

# Native hand-deploys: pm2 surgery on noelle apps / the ecosystem file
check "pm2 restart of a noelle app"      "pm2 restart noelle-app --update-env"                                yes
check "pm2 restart via pnpm-bundled pm2" "pnpm --filter @noelle/cli exec pm2 restart noelle-drafter"          yes
check "pm2 stop of a noelle worker"      "pm2 stop noelle-linkedin-drafter"                                   yes
check "pm2 delete of a noelle app"       "pm2 delete noelle-send"                                             yes
check "pm2 restart of the ecosystem"     "pm2 restart /Users/demooperator/.noelle/ecosystem.config.cjs --update-env" yes
check "pm2 restart all"                  "pm2 restart all"                                                    yes
check "quoted app name still caught"     "pm2 restart \"noelle-app\""                                         yes

# Editing the generated ecosystem
check "sed edit of the ecosystem"        "sed -i '' 's/3001/3002/' /Users/demooperator/.noelle/ecosystem.config.cjs" yes
check "redirect into the ecosystem"      "cat /tmp/x > /Users/demooperator/.noelle/ecosystem.config.cjs"             yes

# Read-only pm2 stays quiet (the verify skill depends on it)
check "pm2 jlist is read-only"           "pm2 jlist"                    no
check "pm2 logs is read-only"            "pm2 logs noelle-drafter"      no

# A description mentioning pm2 must not leak into the command match
check "description leak (harmless cmd)"  "ls -la" no "" "check pm2 restart noelle-app logs"

# Main-checkout deploy builds and hand-merges; worktrees exempt via cwd ONLY
check "ff-only origin/main (no cwd)"     "git merge --ff-only origin/main"       yes
check "ff-only origin/main (main cwd)"   "git merge --ff-only origin/main"       yes "$MAIN"
check "ff-only origin/main (worktree)"   "git merge --ff-only origin/main"       no  "$WT"
check "app build in the main checkout"   "pnpm --filter @noelle/app build"       yes "$MAIN"
check "app build in a worktree"          "pnpm --filter @noelle/app build"       no  "$WT"
check "turbo app build in main"          "pnpm turbo build --filter=@noelle/app" yes "$MAIN"
check "next build in the main checkout"  "next build"                            yes "$MAIN"
check "hand next start in main"          "pnpm --filter @noelle/app start"       yes "$MAIN"
check "worktree string cannot self-silence" "pnpm --filter @noelle/app build # .claude/worktrees" yes "$MAIN"

# Lima-era patterns still guarded (VM is a stopped rollback box)
check "rsync to lima VM"                 "rsync -az ./ lima-default:noelle/"        yes
check "pm2 restart over lima"            "limactl shell default -- pm2 restart all" yes

# Unrelated commands stay quiet
check "unrelated build"                  "pnpm -r build"                no
check "unrelated rsync"                  "rsync -a a/ b/"               no
check "packages build in a worktree"     "pnpm turbo build --filter=./packages/*" no "$WT"

# Malformed payloads fail open
if printf 'not json' | bash "$HOOK" >/dev/null 2>&1; then
  echo "ok: malformed payload fails open"
else
  echo "FAIL: malformed payload should exit 0"; fail=1
fi

[ "$fail" = 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit $fail

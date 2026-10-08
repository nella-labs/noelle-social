#!/usr/bin/env bash
# PreToolUse(Bash) guard: steer sessions away from hand-rolled noelle deploys.
# Deploys are AUTOMATIC on merge to main: the com.noelle.autoupdate LaunchAgent
# runs `noelle sync` every ~10 min, which fetches origin, fast-forwards main,
# builds packages + the dashboard, restarts pm2, and smoke-checks the ports.
#
# Sanctioned: a command that IS `noelle sync` / `noelle deploy` (first token
# anchored, so a compound like `pm2 delete noelle-app && noelle sync` cannot
# ride along), read-only pm2 (jlist/status/logs/describe), and merge/build
# work inside a .claude/worktrees checkout (judged by the session cwd only).
#
# MODE=warn  → print guidance, exit 0 (allow). Start here; watch what it catches.
# MODE=block → print guidance, exit 2 (deny). Flip when trusted.
MODE=warn

payload="$(cat)"

# Parse the payload with jq: the old sed extraction was greedy (a description
# field leaked into the command; escaped quotes broke it). Fail-open when jq
# is missing or the payload is not valid JSON.
command -v jq >/dev/null 2>&1 || exit 0
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)" || exit 0
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)" || exit 0
[ -n "$cmd" ] || exit 0

# Worktree sessions merge origin and build the app freely; that is normal
# verification work, not a deploy. Derived from the parsed cwd ONLY (a
# command string mentioning worktrees must not self-silence the guard).
# pm2 checks still apply everywhere because the pm2 daemon is shared.
in_worktree=no
case "$cwd" in *".claude/worktrees"*) in_worktree=yes ;; esac

blocked=0

# Native-era hand-deploys: pm2 process surgery on the noelle apps or the
# ecosystem file, and edits to the generated ecosystem (lost on regen).
case "$cmd" in
  *pm2*restart*noelle-*|*pm2*start*noelle-*|*pm2*stop*noelle-*|*pm2*delete*noelle-*) blocked=1 ;;
  *pm2*restart*ecosystem.config.cjs*|*pm2*start*ecosystem.config.cjs*) blocked=1 ;;
  *pm2*stop*ecosystem.config.cjs*|*pm2*delete*ecosystem.config.cjs*)   blocked=1 ;;
  *"pm2 restart all"*|*"pm2 start all"*)                               blocked=1 ;;
  *sed*ecosystem.config.cjs*|*tee*ecosystem.config.cjs*)               blocked=1 ;;
  *">"*ecosystem.config.cjs*)                                          blocked=1 ;;
esac

# Lima-era (VM) hand-deploys. The VM survives only as a stopped rollback box;
# touching it by hand is still a deploy smell.
case "$cmd" in
  *rsync*lima-*:*noelle*)  blocked=1 ;;
  *rsync*:*~/noelle*)      blocked=1 ;;
  *limactl*shell*pm2*)     blocked=1 ;;
  *"ssh lima-"*pm2*)       blocked=1 ;;
esac

# Main-checkout hand-merges and deploy builds (worktrees exempt above).
if [ "$in_worktree" = no ]; then
  case "$cmd" in
    *"git merge --ff-only origin/main"*|*"git merge origin/main"*) blocked=1 ;;
    *"@noelle/app"*build*|*build*"@noelle/app"*)                   blocked=1 ;;
    *"@noelle/app"*start*)                                         blocked=1 ;;
    *"next build"*|*"next start"*)                                 blocked=1 ;;
  esac
fi

[ "$blocked" = 0 ] && exit 0

# Sanctioned pipeline entrypoints, anchored to the command's FIRST token so a
# blocked command cannot smuggle "noelle sync" in a later clause. Evaluated
# AFTER the block patterns on purpose, and never for compound commands (a
# `noelle sync && pm2 delete ...` still gets the guidance).
case "$cmd" in
  "noelle sync"*|"noelle deploy"*)
    case "$cmd" in
      *"&&"*|*";"*|*"|"*|*'$('*|*'`'*) : ;;
      *) exit 0 ;;
    esac
    ;;
esac

cat >&2 <<'MSG'
⛔ Deploys are automatic on merge to main (native Mac runtime).
Merge the PR; the com.noelle.autoupdate tick runs `noelle sync` within ~10 min:
fetch origin → fast-forward main → build packages + dashboard → restart pm2 →
smoke-check :3001 and :18791 (pages via NOELLE_ALERT_CMD on failure).
Drift/lock:  noelle deploy status    Manual kick:  noelle sync  or  noelle deploy --force
Hand pm2 restarts and ecosystem.config.cjs edits are lost on the next tick or regen.
See CLAUDE.md (Deployment) and docs/runbook.md.
MSG

[ "$MODE" = block ] && exit 2
exit 0

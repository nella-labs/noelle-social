#!/usr/bin/env bash
# Harden a macOS Mac mini for unattended Noelle actuation.
# Runs the SCRIPTABLE hardening, then prints the manual (GUI/admin) steps it
# cannot safely script. Idempotent. See docs/mac-mini-runbook.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agent_src="$here/com.noelle.caffeinate.plist"
agent_dst="$HOME/Library/LaunchAgents/com.noelle.caffeinate.plist"
uid="$(id -u)"

echo "==> Preventing system + disk sleep on AC (needs sudo). Display sleep is left"
echo "    enabled on purpose: dark screens are fine, only lock/system-sleep hurt."
sudo pmset -c sleep 0 disksleep 0

echo "==> Disabling the screensaver + password-on-wake for $(id -un)"
defaults -currentHost write com.apple.screensaver idleTime -int 0 || true
defaults write com.apple.screensaver askForPassword -int 0 || true
defaults write com.apple.screensaver askForPasswordDelay -int 0 || true

echo "==> Installing the caffeinate LaunchAgent"
mkdir -p "$HOME/Library/LaunchAgents"
cp "$agent_src" "$agent_dst"
launchctl bootout "gui/$uid/com.noelle.caffeinate" 2>/dev/null || true
launchctl bootstrap "gui/$uid" "$agent_dst"
launchctl enable "gui/$uid/com.noelle.caffeinate"
echo "    Loaded: keeps the system awake and respawns caffeinate if it dies."

echo "==> Persisting the pm2 worker set across reboots"
if command -v pm2 >/dev/null 2>&1; then
  pm2 save || true
  echo "    Now run the command 'pm2 startup' prints (needs sudo) once, so pm2"
  echo "    resurrects the workers on login."
else
  echo "    pm2 not on PATH here; run 'pm2 save' + 'pm2 startup' where the workers run."
fi

cat <<'MANUAL'

==> MANUAL steps (GUI / admin, cannot be scripted safely):
  1. FileVault OFF: System Settings > Privacy & Security > FileVault > Turn Off.
     FileVault disables auto-login, so any reboot (power blip, update, panic)
     would strand every worker at the pre-boot unlock screen. Trade disk
     encryption for unattended reboot recovery, or use `sudo fdesetup authrestart`
     for PLANNED reboots only (useless for unplanned power loss).
  2. Auto-login ON: System Settings > Users & Groups > Automatically log in as <user>.
  3. Never lock: System Settings > Lock Screen > "Require password after ..." = Never,
     and "Start Screen Saver when inactive" = Never. Do not manually lock the machine:
     Ctrl-Cmd-Q, a hot corner, or closing the lid all freeze CDP input.
  4. TCC grants for the worker node binary (launchd jobs do NOT inherit these, the
     classic works-in-Terminal / dead-as-a-LaunchAgent failure):
       Privacy & Security > Full Disk Access  -> add your node binary (or a signed
         wrapper .app).
       Privacy & Security > Automation        -> allow it to control Google Chrome
         (trigger the prompt once from an interactive run, then approve).
     Re-grant after any unsigned-binary rebuild.
  5. Chrome: add Google Chrome as a Login Item, signed into the dedicated actuator
     profile, DevTools closed. Keep its window foreground and non-occluded on a run.

Verify: `pmset -g | grep -E 'sleep|disksleep'` shows 0; `launchctl list | grep noelle`
shows com.noelle.caffeinate; the Mac survives a test reboot back into the desktop.
MANUAL
echo "==> Scriptable hardening done."

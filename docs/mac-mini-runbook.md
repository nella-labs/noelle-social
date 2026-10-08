# Mac mini runbook (unattended Noelle actuation)

Noelle workers can run natively on a configured macOS host. For lights-out reply actuation the machine must stay awake, logged in, unlocked, and survive reboots with no human present. This is the one-time hardening plus the operating rules. Artifacts live in `infra/mac-mini/`. Strategy context: `docs/reply-actuation-strategy.md`.

## One-time hardening

Run the scriptable part, then do the manual GUI/admin steps it prints:

```sh
bash infra/mac-mini/harden-mac-mini.sh
```

It prevents system + disk sleep on AC (`pmset`), disables the screensaver and password-on-wake, installs the `com.noelle.caffeinate` LaunchAgent (keeps the system awake, respawns on crash), and reminds you to run `pm2 startup`.

Then the manual steps (the script cannot do these safely):

1. **FileVault OFF + auto-login ON.** FileVault disables auto-login, so any reboot strands every worker at the pre-boot unlock screen.
2. **Never lock.** Password-on-wake Never, screensaver Never. Never manually lock (Ctrl-Cmd-Q, hot corners, and closing the lid all freeze CDP input).
3. **TCC grants.** Give the worker `node` binary Full Disk Access and Automation (control Chrome). launchd jobs do not inherit these.
4. **Chrome.** Add Google Chrome as a Login Item, signed into the dedicated actuator profile, DevTools closed.

## Why each item (what breaks if skipped)

| Item | Failure if skipped |
|---|---|
| pmset + caffeinate | System/idle sleep pauses the pm2 workers and Chrome |
| Never lock | A locked session freezes CDP input (WindowServer stops honoring synthetic input) |
| FileVault off + auto-login | A reboot strands every worker at the pre-boot unlock screen |
| TCC pre-grant | launchd-spawned `node` dies silently without Full Disk Access / Automation |
| Chrome foreground | `Input.*` CDP events only reliably reach the active, non-occluded tab |
| Display sleep | Harmless. Screens can go dark overnight; it does not lock the session |

## Auto-start on login

- **Workers:** `pm2 save` + `pm2 startup` (pm2 generates its own resurrect LaunchAgent).
- **Sleep prevention:** `com.noelle.caffeinate` (RunAtLoad + KeepAlive).
- **Chrome + actuator:** Chrome as a Login Item. The actuator runs manually today (Run/STOP); it becomes autonomous once the Phase 5 autonomy layer lands.

## Operating rules

- Never open DevTools on the actuator Chrome during a run: it blocks `chrome.debugger`.
- Keep egress on the one home residential IP. Plan a LinkedIn re-auth roughly every two weeks (`li_at` burns on an IP/geo/security change); the actuator halts on a detected challenge.
- Reboots: prefer none. For a planned OS update, either reboot normally (FileVault off + auto-login brings everything back) or `sudo fdesetup authrestart` if you kept FileVault on. Unplanned power loss with FileVault on strands the machine, which is why FileVault-off is the recommendation.

## Verify

- `pmset -g | grep -E 'sleep|disksleep'` shows `0`.
- `launchctl list | grep noelle` shows `com.noelle.caffeinate`.
- A test reboot returns to the desktop with the pm2 workers up (`pm2 ls`) and Chrome open, no password prompt.

import { homedir } from "node:os";
import { resolve } from "node:path";

export function launchAgentPath(label: string): string {
  return resolve(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function xml(value: string): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
  return value.replace(/[&<>"']/g, (character) => entities[character]!);
}

export function renderHostLauncher(i: {
  nodeBin: string; cliEntry: string; pathDirs: string[]; args: string[]; home?: string;
}): string {
  const path = [...i.pathDirs, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return `#!/bin/bash
# Managed Noelle host launcher. Re-run install to change.
export PATH=${shellQuote(path)}:"$PATH"
${i.home ? `export NOELLE_HOME=${shellQuote(i.home)}\n` : ""}exec ${[i.nodeBin, i.cliEntry, ...i.args].map(shellQuote).join(" ")}
`;
}

export function renderHostPlist(i: {
  label: string; launcher: string; log: string; processType: "Interactive" | "Standard"; intervalSeconds?: number;
}): string {
  if (i.intervalSeconds !== undefined && (!Number.isSafeInteger(i.intervalSeconds) || i.intervalSeconds <= 0)) {
    throw new Error("Launch interval must be a positive integer");
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(i.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${xml(i.launcher)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  ${i.intervalSeconds === undefined ? "" : `<key>StartInterval</key>\n  <integer>${i.intervalSeconds}</integer>\n  `}<key>StandardOutPath</key>
  <string>${xml(i.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(i.log)}</string>
  <key>ProcessType</key>
  <string>${i.processType}</string>
</dict>
</plist>
`;
}

import { existsSync } from "node:fs";
import { hasCommand, platform, run } from "./platform.js";
import type { TailscaleMode } from "../config.js";

/**
 * Tailscale exposure for the self-host dashboard (host-side, Mac).
 *
 * The dashboard runs inside the Lima VM on 127.0.0.1:<app>; Lima forwards that
 * to the Mac host. `tailscale serve --bg` (verified against tailscale 1.96) then
 * publishes the host port onto the tailnet so a phone can reach it:
 *   https mode → https://<host>.<tailnet>.ts.net      (cert on 443)
 *   http  mode → http://<host>.<tailnet>.ts.net:<app> (plain, no cert setup)
 *
 * `--bg` makes the serve config persistent (survives reboots), so the login
 * LaunchAgent only has to re-run it after a fresh tailnet login if needed.
 */

const APP_BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** Resolve the tailscale CLI: PATH first, then the macOS app bundle. */
export async function tailscaleBin(): Promise<string | null> {
  if (await hasCommand("tailscale")) return "tailscale";
  if (platform() === "darwin" && existsSync(APP_BIN)) return APP_BIN;
  return null;
}

export async function tailscaleInstalled(): Promise<boolean> {
  return (await tailscaleBin()) !== null;
}

export function installHint(): string {
  return platform() === "darwin"
    ? "brew install tailscale  (or the Tailscale.app from the App Store)"
    : "see https://tailscale.com/download/linux";
}

/**
 * `tailscale serve` args (pure — unit-tested). `appPort` is the local dashboard
 * port; `listenPort` is the tailnet-facing port (443 = HTTPS root, or e.g. 8443
 * to stay off a shared root). The mode flag pins which listener we own, so
 * `serveOff` can target exactly this port without touching other apps.
 */
export function serveArgs(appPort: number, mode: TailscaleMode, listenPort: number): string[] {
  // --yes: no interactive confirm. --bg: persistent background serve.
  const flag = mode === "http" ? `--http=${listenPort}` : `--https=${listenPort}`;
  return ["serve", "--bg", "--yes", flag, String(appPort)];
}

/** Parse `tailscale status --json` → the node's DNSName (trailing dot stripped). */
export function parseDnsName(statusJson: string): string | null {
  try {
    const parsed = JSON.parse(statusJson) as { Self?: { DNSName?: string } };
    const dns = parsed.Self?.DNSName;
    if (!dns) return null;
    return dns.replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** Build the public URL from a DNSName + mode + listen port (pure — tested). */
export function buildUrl(dnsName: string, mode: TailscaleMode, listenPort: number): string {
  if (mode === "http") return `http://${dnsName}:${listenPort}`;
  return listenPort === 443 ? `https://${dnsName}` : `https://${dnsName}:${listenPort}`;
}

/** Start (or update) the persistent serve on `listenPort`. Throws on error. */
export async function serve(appPort: number, mode: TailscaleMode, listenPort: number): Promise<void> {
  const bin = await tailscaleBin();
  if (!bin) throw new Error(`tailscale not found. Install it: ${installHint()}`);
  await run(bin, serveArgs(appPort, mode, listenPort), { inherit: true });
}

/**
 * Tear down ONLY our serve on `listenPort` (e.g. `tailscale serve --https=443
 * off`). Never `tailscale serve reset` — that would wipe every other app the
 * operator serves on this node.
 */
export async function serveOff(mode: TailscaleMode, listenPort: number): Promise<void> {
  const bin = await tailscaleBin();
  if (!bin) return;
  const flag = mode === "http" ? `--http=${listenPort}` : `--https=${listenPort}`;
  await run(bin, ["serve", flag, "off"], { allowFailure: true });
}

/** Resolve the public URL for the current node, or null if unavailable. */
export async function resolveUrl(mode: TailscaleMode, listenPort: number): Promise<string | null> {
  const bin = await tailscaleBin();
  if (!bin) return null;
  const r = await run(bin, ["status", "--json"], { allowFailure: true });
  const dns = parseDnsName(r.stdout);
  return dns ? buildUrl(dns, mode, listenPort) : null;
}

/** Human-readable `tailscale serve status` (best-effort). */
export async function serveStatus(): Promise<string> {
  const bin = await tailscaleBin();
  if (!bin) return "(tailscale not installed)";
  const r = await run(bin, ["serve", "status"], { allowFailure: true });
  return (r.stdout || r.stderr || "").trim() || "(no serve config)";
}

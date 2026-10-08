import { hasCommand, run, platform } from "./platform.js";

/**
 * Cloudflare tunnel (self-hosted remote access — preferred over Vercel).
 *
 * v1 uses a Quick Tunnel: `cloudflared tunnel --url http://127.0.0.1:<app>`
 * prints an ephemeral *.trycloudflare.com hostname, no account/login needed.
 * For a stable hostname, run a named tunnel (cloudflared login + tunnel
 * create/route) and set NOELLE_TUNNEL_HOSTNAME so the System page shows it.
 */

export async function cloudflaredInstalled(): Promise<boolean> {
  return hasCommand("cloudflared");
}

export function installHint(): string {
  return platform() === "darwin"
    ? "brew install cloudflared"
    : "see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ (apt: cloudflared)";
}

/**
 * Run a Quick Tunnel in the foreground (stdio inherited) so the operator sees
 * the generated public URL. Blocks until interrupted.
 */
export async function runQuickTunnel(appPort: number): Promise<void> {
  await run("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${appPort}`], {
    inherit: true,
    allowFailure: true,
  });
}

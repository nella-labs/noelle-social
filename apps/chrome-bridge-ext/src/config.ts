// Bridge base URL. The extension talks to the local Chrome Bridge control server
// (apps/chrome-bridge) over loopback HTTP. The base URL is overridable via
// chrome.storage.local key "bridge.config" ({ baseUrl }) so an operator can point
// the extension at a non-default port without a rebuild; it defaults to the
// bridge's documented loopback address.
export const DEFAULT_BASE_URL = "http://127.0.0.1:18792";

export interface BridgeConfig {
  baseUrl: string;
}

// Cache the resolved config for the service-worker lifetime so bridgeUrl() isn't
// a storage read per request. Invalidated by the storage.onChanged listener below
// (and naturally reset on every SW cold start).
let cached: BridgeConfig | null = null;

export async function getBridgeConfig(): Promise<BridgeConfig> {
  if (cached) return cached;
  try {
    const r = await chrome.storage.local.get("bridge.config");
    const raw = r["bridge.config"] as Partial<BridgeConfig> | undefined;
    const baseUrl =
      typeof raw?.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : DEFAULT_BASE_URL;
    cached = { baseUrl: baseUrl.replace(/\/+$/, "") }; // strip trailing slash so join is clean
  } catch {
    cached = { baseUrl: DEFAULT_BASE_URL };
  }
  return cached;
}

/** Join a path onto the configured bridge base URL. */
export async function bridgeUrl(path: string): Promise<string> {
  const { baseUrl } = await getBridgeConfig();
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

// Drop the cache when the operator changes the config so the next request picks up
// the new base URL without a SW restart. Guarded so importing this module in a
// non-extension context (the vitest node env, via ops.ts) never throws.
if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["bridge.config"]) cached = null;
  });
}

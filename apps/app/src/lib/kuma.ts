/**
 * Server-side fetcher for the Uptime Kuma public status-page API.
 *
 * Kuma is deployed on noelle-vm-0 behind cloudflared at status.trynoelle.com.
 * Its public status-page endpoints don't require auth — the slug is the
 * stable identifier (default `main`, which holds both Nella and Noelle
 * monitors today; create a separate `noelle` page in the Kuma UI to split).
 *
 * Reference: https://github.com/louislam/uptime-kuma — endpoints are
 *   GET /api/status-page/<slug>            → group + monitor metadata
 *   GET /api/status-page/heartbeat/<slug>  → last 50 heartbeats + uptime %
 */

export type KumaMonitorStatus = "up" | "down" | "pending" | "maintenance" | "unknown";

export interface KumaHeartbeat {
  status: KumaMonitorStatus;
  pingMs: number | null;
  at: string;
}

export interface KumaMonitor {
  id: number;
  name: string;
  type: string;
  status: KumaMonitorStatus;
  lastPingMs: number | null;
  lastCheckAt: string | null;
  uptime24h: number | null;
  uptime30d: number | null;
  beats: KumaHeartbeat[];
  p95Ms: number | null;
}

function percentile(values: number[], p: number): number | null {
  const cleaned = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (cleaned.length === 0) return null;
  const idx = Math.min(cleaned.length - 1, Math.floor((p / 100) * cleaned.length));
  return cleaned[idx] ?? null;
}

export interface KumaStatusSnapshot {
  slug: string;
  title: string;
  publicUrl: string;
  monitors: KumaMonitor[];
}

interface KumaStatusPageConfig {
  config: { slug: string; title: string };
  publicGroupList: Array<{
    id: number;
    name: string;
    monitorList: Array<{ id: number; name: string; type: string }>;
  }>;
}

interface KumaHeartbeatResponse {
  heartbeatList: Record<string, Array<{ status: 0 | 1 | 2 | 3; time: string; msg: string; ping: number }>>;
  uptimeList: Record<string, number>;
}

function mapStatus(code: 0 | 1 | 2 | 3 | undefined): KumaMonitorStatus {
  switch (code) {
    case 1:
      return "up";
    case 0:
      return "down";
    case 2:
      return "pending";
    case 3:
      return "maintenance";
    default:
      return "unknown";
  }
}

const DEFAULT_BASE_URL = "https://status.trynoelle.com";
const DEFAULT_SLUG = "main";

export function getKumaConfig(): { baseUrl: string; slug: string } {
  return {
    baseUrl: process.env.KUMA_BASE_URL ?? DEFAULT_BASE_URL,
    slug: process.env.KUMA_STATUS_SLUG ?? DEFAULT_SLUG,
  };
}

export async function fetchKumaStatus(
  slug = DEFAULT_SLUG,
  options: { baseUrl?: string; revalidateSeconds?: number } = {},
): Promise<KumaStatusSnapshot | null> {
  const baseUrl = options.baseUrl ?? process.env.KUMA_BASE_URL ?? DEFAULT_BASE_URL;
  const revalidate = options.revalidateSeconds ?? 30;

  // Identify ourselves with a stable UA so Vercel-side logs are easy to
  // grep and so any future Cloudflare rule can allowlist us by name.
  const headers: HeadersInit = {
    Accept: "application/json, text/plain, */*",
    "User-Agent": "noelle-app/1.0 (+https://app.trynoelle.com; ops health card)",
  };

  // The full Vercel → Cloudflare → cloudflared → Kuma chain can blow past
  // a single short timeout on a cold start. Try once with a 6s budget,
  // then once more with a longer one before giving up.
  async function fetchWithBudget(url: string, ms: number) {
    return fetch(url, {
      next: { revalidate },
      signal: AbortSignal.timeout(ms),
      headers,
    });
  }

  async function tryOnce(timeoutMs: number) {
    return Promise.all([
      fetchWithBudget(`${baseUrl}/api/status-page/${slug}`, timeoutMs),
      fetchWithBudget(`${baseUrl}/api/status-page/heartbeat/${slug}`, timeoutMs),
    ]);
  }

  try {
    let configRes: Response;
    let heartbeatRes: Response;
    try {
      [configRes, heartbeatRes] = await tryOnce(6_000);
    } catch (firstErr) {
      console.warn("[kuma] first attempt failed, retrying with longer budget", firstErr);
      [configRes, heartbeatRes] = await tryOnce(12_000);
    }

    if (!configRes.ok || !heartbeatRes.ok) {
      console.warn("[kuma] non-OK response", configRes.status, heartbeatRes.status);
      return null;
    }

    const config = (await configRes.json()) as KumaStatusPageConfig;
    const heartbeat = (await heartbeatRes.json()) as KumaHeartbeatResponse;

    const monitors: KumaMonitor[] = config.publicGroupList
      .flatMap((g) => g.monitorList)
      .map((m) => {
        const rawBeats = heartbeat.heartbeatList[String(m.id)] ?? [];
        const latest = rawBeats.at(-1);
        const beats: KumaHeartbeat[] = rawBeats.map((b) => ({
          status: mapStatus(b.status),
          pingMs: b.ping ?? null,
          at: b.time,
        }));
        const p95 = percentile(
          rawBeats.filter((b) => b.status === 1).map((b) => b.ping),
          95,
        );
        return {
          id: m.id,
          name: m.name,
          type: m.type,
          status: mapStatus(latest?.status),
          lastPingMs: latest?.ping ?? null,
          lastCheckAt: latest?.time ?? null,
          uptime24h: heartbeat.uptimeList[`${m.id}_24`] ?? null,
          uptime30d: heartbeat.uptimeList[`${m.id}_720`] ?? null,
          beats,
          p95Ms: p95,
        };
      });

    return {
      slug: config.config.slug,
      title: config.config.title,
      publicUrl: `${baseUrl}/status/${config.config.slug}`,
      monitors,
    };
  } catch (err) {
    console.warn("[kuma] fetch threw", err);
    return null;
  }
}

export function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso.replace(" ", "T") + "Z");
  if (Number.isNaN(parsed.getTime())) return "—";
  const diffSec = Math.max(0, Math.round((Date.now() - parsed.getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86_400)}d ago`;
}

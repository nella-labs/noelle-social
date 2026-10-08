import type { Notifier, NotifyArgs, NotifyResult } from "./notifier.js";

export interface AlertTarget {
  orgId: string;
  instanceId: string;
}
export type AlertOnceResult = NotifyResult | { status: "throttled" | "in_progress" | "inactive" };
type Claim = { running: boolean; retained: boolean; completedAt?: number; intervalMs: number };
const DEFAULT_INTERVAL_MS = 30 * 60_000;

/** Receipt-based per-process throttling, bounded by the full current roster and live claims. */
export function createAlertOnce<K extends string>(deps: {
  notifier: Notifier;
  kinds: readonly K[];
  log: { error: (obj: Record<string, unknown>, message: string) => void };
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const kinds = new Set<string>(deps.kinds);
  const claims = new Map<string, Claim>();
  let roster = new Set<string>();
  const targetKey = (target: AlertTarget) => JSON.stringify([target.orgId, target.instanceId]);

  return {
    /** Always supply the complete current roster, before worker consent gates. */
    reconcileInstances(targets: readonly AlertTarget[]): void {
      roster = new Set(targets.map(targetKey));
      const at = now();
      for (const [key, claim] of claims) {
        const [orgId, instanceId] = JSON.parse(key) as [string, string, string];
        claim.retained = roster.has(targetKey({ orgId, instanceId }));
        if (
          !claim.running &&
          (!claim.retained ||
            (claim.completedAt !== undefined && at - claim.completedAt >= claim.intervalMs))
        )
          claims.delete(key);
      }
    },
    async notify(
      args: NotifyArgs & { instanceId: string; kind: K; throttleMs?: number },
    ): Promise<AlertOnceResult> {
      if (!kinds.has(args.kind) || !roster.has(targetKey(args))) return { status: "inactive" };
      const key = JSON.stringify([args.orgId, args.instanceId, args.kind]);
      const previous = claims.get(key);
      if (previous?.running) return { status: "in_progress" };
      if (previous?.completedAt !== undefined && now() - previous.completedAt < previous.intervalMs)
        return { status: "throttled" };
      const intervalMs =
        Number.isFinite(args.throttleMs) && args.throttleMs! > 0
          ? Math.max(1, Math.floor(args.throttleMs!))
          : DEFAULT_INTERVAL_MS;
      const claim: Claim = { running: true, retained: true, intervalMs };
      claims.set(key, claim);
      const { instanceId, kind, throttleMs: _interval, ...notification } = args;
      try {
        const result = await deps.notifier.notify(notification);
        if (result.status === "sent") {
          if (!result.request.trim() || result.request.length > 65_536)
            return {
              status: "error",
              channel: "pushover",
              detail: "invalid notification acceptance receipt",
            };
          claim.completedAt = now();
        }
        return result;
      } catch {
        deps.log.error({ orgId: args.orgId, instanceId, kind }, "alert notification unavailable");
        return {
          status: "error",
          channel: "pushover",
          detail: "notification dispatch unavailable",
        };
      } finally {
        claim.running = false;
        // Departed completions cannot repopulate the latest roster. Failed delivery retries next poll.
        if (!claim.retained || claim.completedAt === undefined) claims.delete(key);
      }
    },
  };
}

"use client";

import * as React from "react";
import { useMounted } from "@/lib/use-mounted";
import {
  quietHoldEndMs,
  fmtQuietClock,
  QUIET_START_HOUR_UTC,
  QUIET_END_HOUR_UTC,
} from "@/lib/quiet-window";

/**
 * Countdown chip rendered next to a pending approval that the drafter has
 * stamped with `auto_send_target_at`. Ticks every second so the founder sees
 * the time-to-fire and can intervene (Skip) before the send worker picks it
 * up on its next tick.
 *
 * States:
 *   - "auto · 4m 12s"          — target_at > now
 *   - "holds till 12:00 · quiet" — target_at is past but now sits inside the
 *                         overnight quiet window: the send worker deliberately
 *                         won't fire until quiet ends, so this is expected, not
 *                         a stall (calm color, NOT a warning).
 *   - "auto · firing"          — target_at <= now (and ≤ 60s ago), not quiet
 *   - "auto · overdue"         — target_at <= now - 60s (worker hasn't picked
 *                         it up yet, suggests the send worker is stalled or
 *                         rate-braked; useful operator hint)
 */
export function AutoSendChip({ targetAt }: { targetAt: string }) {
  const targetMs = React.useMemo(() => new Date(targetAt).getTime(), [targetAt]);
  // `null` until mounted so the server render and first client render agree
  // (a Date.now()-seeded countdown otherwise aborts hydration); then it ticks.
  const [now, setNow] = React.useState<number | null>(null);
  const mounted = useMounted();

  React.useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const remainingMs = now === null ? 0 : targetMs - now;
  // A past-due stamp inside the quiet window isn't stalled — the send worker
  // holds it until quiet ends. Computed only once `now` is set (post-mount) so
  // it never diverges between the server render and hydration.
  const holdEnd =
    mounted && now !== null && remainingMs <= 0
      ? quietHoldEndMs(now, {
          startHourUtc: QUIET_START_HOUR_UTC,
          endHourUtc: QUIET_END_HOUR_UTC,
        })
      : null;

  const label = !mounted
    ? "auto"
    : remainingMs > 0
      ? `auto · ${fmtCountdown(remainingMs)}`
      : holdEnd !== null
        ? `holds till ${fmtQuietClock(holdEnd)} · quiet`
        : remainingMs > -60_000
          ? "auto · firing"
          : "auto · overdue";

  const color =
    !mounted || remainingMs > 0
      ? "var(--ink-muted)"
      : holdEnd !== null
        ? "var(--ink-muted)"
        : remainingMs > -60_000
          ? "var(--accent)"
          : "var(--warn)";

  return (
    <span
      className="tag"
      style={{
        fontSize: 10.5,
        color,
        fontFamily: "var(--mono)",
        letterSpacing: "0.06em",
      }}
      title={mounted ? `Scheduled for ${new Date(targetMs).toLocaleString()}` : "Scheduled for auto-send"}
    >
      {label}
    </span>
  );
}

function fmtCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm.toString().padStart(2, "0")}m`;
}

"use client";

import { useMemo, useRef, useState } from "react";
import styles from "./studio.module.css";
import { useMounted } from "@/lib/use-mounted";
import { useScheduleCalendar } from "./useScheduleCalendar";
import { canMutateCalendarSlot, type CalendarSlot, type ScheduleWindow } from "./schedule-slots";
export type { CalendarSlot } from "./schedule-slots";
import {
  addDays,
  addMonths,
  dayOfMonth,
  isSameMonth,
  monthLabel,
  monthMatrix,
  startOfWeekMonday,
  WEEKDAY_SHORT,
  weekDays,
} from "./schedule-dates";

/** Visual meta per slot status — dot colour + short label. */
const STATUS_META: Record<string, { color: string; label: string }> = {
  empty: { color: "var(--ink-soft)", label: "reserved" },
  drafting: { color: "var(--info)", label: "drafting" },
  drafted: { color: "var(--ink-2)", label: "drafted" },
  ready: { color: "var(--accent)", label: "ready" },
  publishing: { color: "var(--accent)", label: "publishing" },
  published: { color: "var(--ok)", label: "posted" },
  failed: { color: "var(--danger)", label: "failed" },
};

function statusMeta(status: string) {
  return STATUS_META[status] ?? { color: "var(--ink-soft)", label: status };
}

function formatTime(iso: string, mounted: boolean): string {
  if (!mounted) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function ScheduleCalendar({
  orgSlug,
  today,
  initialWindow,
  slots: initialSlots,
  platform,
  laneColor,
  canAutoPost,
  emptyHint,
}: {
  orgSlug: string;
  today: string;
  /** Exact half-open server read window. */
  initialWindow: ScheduleWindow;
  slots: CalendarSlot[];
  /** Lane platform ("x" | "linkedin" | … | "all") — used to fetch far months on demand. */
  platform: string;
  laneColor: string;
  canAutoPost: boolean;
  emptyHint: string;
}) {
  const mounted = useMounted();
  const [dragOver, setDragOver] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);

  const [view, setView] = useState<"week" | "month">("week");
  const [anchor, setAnchor] = useState(today);

  const weekStart = useMemo(() => startOfWeekMonday(anchor), [anchor]);
  const weekCells = useMemo(() => weekDays(weekStart), [weekStart]);
  const monthWeeks = useMemo(() => monthMatrix(anchor), [anchor]);
  const visibleDays = useMemo(() => view === "week" ? weekCells : monthWeeks.flat(), [view, weekCells, monthWeeks]);
  const visibleWindow = useMemo(() => ({
    from: `${visibleDays[0]}T00:00:00Z`,
    to: `${addDays(visibleDays[visibleDays.length - 1]!, 1)}T00:00:00Z`,
  }), [visibleDays]);
  const { slots: allSlots, busy: pending, fetching, loaded, readError, mutationError, retry, move, skip } = useScheduleCalendar({
    orgSlug, platform, initialSlots, initialWindow, visibleWindow,
  });
  const byDay = useMemo(() => {
    const map: Record<string, CalendarSlot[]> = {};
    for (const slot of allSlots) (map[slot.slotAt.slice(0, 10)] ??= []).push(slot);
    for (const day of Object.keys(map)) map[day]!.sort((a, b) => a.slotAt.localeCompare(b.slotAt));
    return map;
  }, [allSlots]);

  function onDrop(day: string) {
    const slotId = dragId.current;
    dragId.current = null;
    setDragOver(null);
    if (!slotId) return;
    const slot = allSlots.find((s) => s.id === slotId);
    if (!slot || !canMutateCalendarSlot(slot, pending)) return;
    const at = slot.slotAt;
    if (at.slice(0, 10) === day) return;
    move(slotId, day + at.slice(10));
  }

  function onSkip(slotId: string) {
    const slot = allSlots.find((item) => item.id === slotId);
    if (slot && canMutateCalendarSlot(slot, pending)) skip(slotId);
  }

  const goPrev = () => setAnchor((a) => (view === "week" ? addDays(a, -7) : addMonths(a, -1)));
  const goNext = () => setAnchor((a) => (view === "week" ? addDays(a, 7) : addMonths(a, 1)));

  const labelAnchor = view === "week" ? weekStart : anchor;
  const rangeLabel =
    view === "week"
      ? `${monthLabel(weekStart).split(" ")[0]} ${dayOfMonth(weekStart)} – ${dayOfMonth(weekCells[6] ?? weekStart)}`
      : (monthLabel(anchor).split(" ")[0] ?? "");
  const year = monthLabel(labelAnchor).split(" ")[1] ?? "";
  const visibleHasSlots = visibleDays.some((d) => (byDay[d]?.length ?? 0) > 0);

  return (
    <div className={`card ${styles.calendar}`} style={{ padding: 0, overflow: "hidden", opacity: pending ? 0.92 : 1, transition: "opacity .15s" }}>
      <div className={styles.calendarToolbar}>
        <div className={styles.calendarTitle}>
          <strong>{rangeLabel}</strong><span>{year}</span>
          {fetching && <span role="status">Loading…</span>}
        </div>
        <div className={styles.calendarControls}>
          <ViewToggle view={view} onChange={setView} />
          <NavBtn dir="prev" onClick={goPrev} />
          <button type="button" className="btn btn-sm" onClick={() => setAnchor(today)}>Today</button>
          <NavBtn dir="next" onClick={goNext} />
        </div>
      </div>

      <CalendarFeedback fetching={fetching} readError={readError} mutationError={mutationError} retry={retry} />

      {view === "week" ? (
        /* ── Week grid ─────────────────────────────────────────── */
        <div className="scroll-x-phone" style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(118px, 1fr))" }}>
          {weekCells.map((day, dayIdx) => {
            const isToday = day === today;
            const items = byDay[day] ?? [];
            const isOver = dragOver === day;
            return (
              <div
                key={day}
                onDragOver={(e) => { e.preventDefault(); setDragOver(day); }}
                onDragLeave={() => setDragOver((d) => (d === day ? null : d))}
                onDrop={() => onDrop(day)}
                style={{
                  minHeight: 360,
                  borderRight: dayIdx === 6 ? "none" : "1px solid var(--rule)",
                  background: isOver
                    ? `color-mix(in oklch, ${laneColor} 10%, var(--paper-2))`
                    : isToday
                      ? "color-mix(in oklch, var(--accent) 5%, var(--paper-2))"
                      : "var(--paper-2)",
                  transition: "background .12s",
                }}
              >
                <div style={{ padding: "9px 10px 7px", borderBottom: "1px solid var(--rule)", display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.08em", color: isToday ? "var(--accent)" : "var(--ink-muted)" }}>
                    {WEEKDAY_SHORT[dayIdx]}
                  </span>
                  <span style={{ fontSize: 15, fontWeight: isToday ? 600 : 500, color: isToday ? "var(--accent)" : "var(--ink-2)" }}>
                    {dayOfMonth(day)}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8 }}>
                  {items.map((s) => (
                    <SlotChip
                      key={s.id}
                      slot={s}
                      time={formatTime(s.slotAt, mounted)}
                      laneColor={laneColor}
                      canAutoPost={canAutoPost}
                      mutable={canMutateCalendarSlot(s, pending)}
                      onDragStart={() => { if (canMutateCalendarSlot(s, pending)) dragId.current = s.id; }}
                      onSkip={() => onSkip(s.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ── Month grid ────────────────────────────────────────── */
        <div className="scroll-x-phone">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(96px, 1fr))", borderBottom: "1px solid var(--rule)" }}>
            {WEEKDAY_SHORT.map((wd) => (
              <div key={wd} style={{ padding: "7px 10px", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.08em", color: "var(--ink-muted)" }}>
                {wd}
              </div>
            ))}
          </div>
          {monthWeeks.map((week) => (
            <div key={week[0]} style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(96px, 1fr))" }}>
              {week.map((day, dayIdx) => {
                const isToday = day === today;
                const inMonth = isSameMonth(day, anchor);
                const items = byDay[day] ?? [];
                const isOver = dragOver === day;
                return (
                  <div

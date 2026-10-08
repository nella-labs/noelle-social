"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { loadScheduleSlotsAction, rescheduleSlotAction, skipSlotAction } from "@/app/app/[orgSlug]/content/schedule-actions";
import { canMutateCalendarSlot, type CalendarSlot, type ScheduleWindow } from "./schedule-slots";

interface Source {
  orgSlug: string;
  platform: string;
  initialSlots: CalendarSlot[];
  initialWindow: ScheduleWindow;
}
interface Read { source: Source; window: ScheduleWindow; revision: number }
interface Snapshot extends Read { rows: CalendarSlot[] }
interface Mutation { source: Source; id: string; nextAt?: string }
interface Owner {
  source: Source;
  window: ScheduleWindow;
  initial: CalendarSlot[];
  snapshot: Snapshot | null;
  read: Read | null;
  readError: string | null;
  mutation: Mutation | null;
  mutationError: boolean;
  forceRead: boolean;
  revision: number;
  mounted: boolean;
}

function key(window: ScheduleWindow): string { return `${window.from}/${window.to}`; }
function covers(outer: ScheduleWindow, inner: ScheduleWindow): boolean {
  return outer.from <= inner.from && inner.to <= outer.to;
}
function rows(owner: Owner): CalendarSlot[] {
  const snapshot = owner.snapshot;
  return snapshot?.source === owner.source && covers(snapshot.window, owner.window) ? snapshot.rows : owner.initial;
}
function view(owner: Owner) {
  const loaded = !owner.forceRead && (covers(owner.source.initialWindow, owner.window)
    || owner.snapshot?.source === owner.source && covers(owner.snapshot.window, owner.window));
  const mutation = owner.mutation?.source === owner.source ? owner.mutation : null;
  return { source: owner.source, slots: rows(owner).map(slot => mutation?.id === slot.id && mutation.nextAt
      ? { ...slot, slotAt: mutation.nextAt } : slot),
    loaded, fetching: !loaded && owner.read !== null, readError: owner.readError !== null,
    mutationError: owner.mutationError, busy: owner.mutation !== null };
}

/** Owns one real read and one additional completed window for this calendar. */
export function useScheduleCalendar({ orgSlug, platform, initialSlots, initialWindow, visibleWindow }: Source & {
  visibleWindow: ScheduleWindow;
}) {
  const { from, to } = initialWindow;
  const source = useMemo(() => ({ orgSlug, platform, initialSlots, initialWindow: { from, to } }),
    [orgSlug, platform, initialSlots, from, to]);
  const { from: visibleFrom, to: visibleTo } = visibleWindow;
  const window = useMemo(() => ({ from: visibleFrom, to: visibleTo }), [visibleFrom, visibleTo]);
  const ownerRef = useRef<Owner | null>(null);
  const [, startTransition] = useTransition();
  const [state, setState] = useState(() => ({ source, slots: initialSlots,
    loaded: covers(initialWindow, visibleWindow), fetching: false, readError: false, mutationError: false, busy: false }));
  const publish = useCallback(() => {
    const owner = ownerRef.current;
    if (owner?.mounted) setState(view(owner));
  }, []);
  const pumpRef = useRef<() => void>(() => {});
  const pump = useCallback(() => {
    const owner = ownerRef.current;
    if (!owner?.mounted || owner.read || owner.mutation || view(owner).loaded || owner.readError === key(owner.window)) return;
    const read = { source: owner.source, window: owner.window, revision: owner.revision };
    owner.read = read;
    publish();
    const current = () => owner.mounted && owner.source === read.source && owner.revision === read.revision
      && key(owner.window) === key(read.window);
    void loadScheduleSlotsAction(read.source.orgSlug, read.source.platform, read.window.from, read.window.to)
      .then(result => {
        if (!current()) return;
        owner.snapshot = { ...read, rows: result };
        owner.forceRead = false;
        owner.readError = null;
      }).catch(() => { if (current()) owner.readError = key(read.window); })
      .finally(() => { owner.read = null; publish(); pumpRef.current(); });
  }, [publish]);

  useLayoutEffect(() => {
    if (ownerRef.current) ownerRef.current.mounted = true;
    return () => { if (ownerRef.current) ownerRef.current.mounted = false; };
  }, []);
  useLayoutEffect(() => {
    const owner = ownerRef.current ??= { source, window, initial: initialSlots,
      snapshot: null, read: null, readError: null, mutation: null, mutationError: false, forceRead: false, revision: 0, mounted: true };
    if (owner.source !== source) {
      owner.source = source;
      owner.initial = initialSlots;
      owner.snapshot = null;
      owner.readError = null;
      owner.mutationError = false;
      owner.forceRead = false;
    } else if (key(owner.window) !== key(window)) {
      owner.readError = null;
      owner.forceRead = false;
    }
    owner.window = window;
    pumpRef.current = pump;
    publish();
    pump();
  }, [source, initialSlots, window, pump, publish]);

  const retry = useCallback(() => {
    const owner = ownerRef.current;
    if (!owner?.mounted) return;
    owner.readError = null;
    owner.forceRead = true;
    publish();
    pumpRef.current();
  }, [publish]);
  const mutate = useCallback((id: string, nextAt?: string) => {
    const owner = ownerRef.current;
    const slot = owner && rows(owner).find(row => row.id === id);
    if (!owner?.mounted || !slot || !canMutateCalendarSlot(slot, owner.mutation !== null)) return;
    const mutation: Mutation = { source: owner.source, id, ...(nextAt ? { nextAt } : {}) };
    owner.mutation = mutation;
    // A pre-write read keeps its admission until settled but cannot replace the receipt.
    owner.revision++;
    owner.mutationError = false;
    publish();
    startTransition(async () => {
      try {
        let patch: Pick<CalendarSlot, "status"> & Partial<Pick<CalendarSlot, "slotAt" | "autoPublish">>;
        if (nextAt) {
          const receipt = await rescheduleSlotAction(mutation.source.orgSlug, id, nextAt);
          patch = { status: receipt.status, slotAt: receipt.slot_at, autoPublish: receipt.auto_publish };
        } else {
          const receipt = await skipSlotAction(mutation.source.orgSlug, id);
          patch = { status: receipt.status };
        }
        if (owner.mounted && owner.source === mutation.source) {
          const apply = (items: CalendarSlot[]) => items.flatMap(row => row.id !== id ? [row]
            : patch.status === "skipped" ? [] : [{ ...row, ...patch }]);
          owner.initial = apply(owner.initial);
          if (owner.snapshot) owner.snapshot = { ...owner.snapshot, rows: apply(owner.snapshot.rows) };
        }
      } catch {
        if (owner.mounted && owner.source === mutation.source) {
          owner.mutationError = true;
          owner.readError = null;
          owner.forceRead = true;
        }
      } finally {
        owner.mutation = null;
        publish();
        pumpRef.current();
      }
    });
  }, [publish, startTransition]);
  const current = state.source === source ? state : { source, slots: initialSlots,
    loaded: covers(initialWindow, visibleWindow), fetching: false, readError: false, mutationError: false, busy: state.busy };
  return { ...current, retry, move: (id: string, slotAt: string) => mutate(id, slotAt), skip: (id: string) => mutate(id) };
}

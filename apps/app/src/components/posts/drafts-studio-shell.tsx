"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Segmented } from "./drafts-studio-chrome";
import { Search } from "lucide-react";
import styles from "./studio.module.css";

/**
 * Shared shell for the Drafts studio — the part that is IDENTICAL across every
 * lane (the standard post studio + Nova's video studio). One source of truth for
 * the responsive 3/2/1-column geometry, the selection + prev/next logic, and the
 * left list rail. Lanes differ only in the editor body + live-preview; this is
 * the chrome they wrap around, so "video" is the same studio as the others, not
 * a parallel copy. See DraftsPanel (text) / VideoDraftsStudio (video).
 */

/** Responsive 3 / 2 / 1-column geometry, measured off the studio's own width. */
export function useStudioColumns() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(1100);
  useEffect(() => {
    if (!wrapRef.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(e.contentRect.width);
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);
  const mode = w >= 1000 ? 3 : w >= 680 ? 2 : 1;
  const gridCols = mode === 3 ? "280px minmax(340px,1fr) 300px" : mode === 2 ? "260px minmax(0,1fr)" : "1fr";
  const listSticky: CSSProperties = mode >= 2 ? { position: "sticky", top: 8 } : {};
  const previewWrap: CSSProperties = mode === 3 ? { position: "sticky", top: 8 } : mode === 2 ? { gridColumn: "1 / -1" } : {};
  return { wrapRef, mode, gridCols, listSticky, previewWrap };
}

/**
 * Selection + prev/next over a filtered list. `all` is the full draft set (used
 * to keep a valid selection as data changes); `filtered` is the visible subset
 * the arrows walk through. `focusId` deep-links a specific draft open.
 */
export function useDraftSelection<T extends { id: string }>(all: T[], filtered: T[], focusId?: string | null) {
  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? all[0]?.id ?? null);

  // Follow an external focus (e.g. the week planner → studio).
  useEffect(() => {
    if (focusId) setSelectedId(focusId);
  }, [focusId]);
  // Drop a selection that no longer exists; fall back to the first visible row.
  useEffect(() => {
    if (selectedId && !all.find((d) => d.id === selectedId)) setSelectedId(null);
  }, [all, selectedId]);
  useEffect(() => {
    if (!selectedId && filtered.length) setSelectedId(filtered[0].id);
  }, [filtered, selectedId]);

  const selected = all.find((d) => d.id === selectedId) ?? null;
  const selIdx = selected ? filtered.findIndex((d) => d.id === selected.id) : -1;
  const goPrev = selIdx > 0 ? () => setSelectedId(filtered[selIdx - 1].id) : undefined;
  const goNext = selIdx >= 0 && selIdx < filtered.length - 1 ? () => setSelectedId(filtered[selIdx + 1].id) : undefined;
  const navPos = selIdx >= 0 ? { idx: selIdx + 1, total: filtered.length } : null;

  return { selectedId, setSelectedId, selected, goPrev, goNext, navPos };
}

/**
 * The left rail of the studio: search · status filter · (optional) extra filter ·
 * the pending idea placeholders · the count · the scrollable list (passed as
 * children) · a clear-filters empty state. Pure chrome — every lane renders the
 * same rail and only supplies its own list cards + status options.
 */
export function StudioListPane({
  search,
  onSearch,
  statusValue,
  onStatus,
  statusOptions,
  extraFilter,
  generating = [],
  count,
  noun = "draft",
  onClearFilters,
  sticky,
  mode,
  children,
}: {
  search: string;
  onSearch: (v: string) => void;
  statusValue: string;
  onStatus: (v: string) => void;
  statusOptions: [string, string][];
  /** Lane-specific extra filter row (e.g. the platform chips on the post studio). */
  extraFilter?: ReactNode;
  /** Ideas awaiting a draft. Their persisted status does not prove a live job. */
  generating?: Array<{ id: string; hook: string }>;
  /** Number of rows currently shown (drives the count line + empty state). */
  count: number;
  noun?: string;
  onClearFilters: () => void;
  sticky: CSSProperties;
  mode: number;
  children: ReactNode;
}) {
  return (
    <div
      className={`card ${styles.listPane}`}
      style={{ padding: 0, overflow: "hidden", ...sticky, display: "flex", flexDirection: "column", maxHeight: mode >= 2 ? "calc(100vh - 220px)" : "none" }}
    >
      <div className={styles.listHeader}>
        <div className={styles.search}>
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search drafts…"
            aria-label="Search drafts"
          />
          <Search size={15} aria-hidden />
        </div>
        <Segmented value={statusValue} onChange={onStatus} options={statusOptions} />
        {extraFilter}
      </div>

      <div className={styles.listBody}>
        {generating.map((idea) => (
          <div key={idea.id} style={{ padding: "10px 11px", marginBottom: 4, borderRadius: 10, background: "var(--paper-2)", boxShadow: "0 0 0 0.5px var(--rule)" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--warn)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Draft pending</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 4 }}>{idea.hook}</div>
          </div>
        ))}
        <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-soft)", padding: "4px 6px 8px" }}>
          {count} {count === 1 ? noun : `${noun}s`}
        </div>
        {children}
        {count === 0 && (
          <div style={{ padding: 18, textAlign: "center", fontSize: 12, color: "var(--ink-muted)" }}>
            No drafts match.{" "}
            <button className="btn btn-sm btn-ghost" style={{ padding: 0, color: "var(--accent)" }} onClick={onClearFilters}>
              Clear filters
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

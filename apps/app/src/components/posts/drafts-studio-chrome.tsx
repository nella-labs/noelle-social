"use client";

import type { CSSProperties, ReactNode } from "react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type { VerifierTrace } from "@/lib/posts-queries";

/**
 * Shared chrome for the Drafts studios (the standard post studio + Nova's video
 * studio). One source of truth for the field look, the labelled Field wrapper,
 * the segmented control, and the verifier-trace card so every lane's editor reads
 * the same — roomy, grounded, consistent — instead of each lane reinventing
 * cramped variants.
 */

/** The standard roomy field surface used for every input/textarea/select. */
export const inputStyle: CSSProperties = {
  width: "100%",
  padding: "9px 11px",
  borderRadius: 12,
  border: "1px solid var(--rule)",
  background: "var(--paper-2)",
  boxShadow: "none",
  fontFamily: "var(--body)",
  fontSize: 13.5,
  color: "var(--ink)",
};

/** A labelled section: an eyebrow label (+ optional right-aligned hint) over its field. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | null;
  children: ReactNode;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 6 }}>
        <span className="eyebrow" style={{ fontSize: 9.5 }}>{label}</span>
        {hint && (
          <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-soft)" }}>
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * Verifier trace: the four-dimension quality grade (Voice / Grounding /
 * Relevance / Format) the post-draft verifier writes on every intern's drafts.
 * Shared so Nova's video studio renders the SAME card as the text studio — the
 * one piece of the "good" draft chrome that was missing from the video lane.
 */
export function VerifierTraceCard({ meta }: { meta: VerifierTrace }) {
  const s = meta.scores;
  const rows: { k: string; n: number }[] = [
    { k: "Voice", n: s.voice }, { k: "Grounding", n: s.grounding },
    { k: "Relevance", n: s.relevance }, { k: "Format", n: s.format },
  ];
  const avg = Math.round((rows.reduce((a, r) => a + r.n, 0) / rows.length) * 100);
  const tries = meta.attempts + 1;
  return (
    <div style={{ padding: 14, borderRadius: 10, background: "var(--paper-2)", boxShadow: "0 0 0 0.5px var(--rule)" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <span className="eyebrow" style={{ fontSize: 9.5 }}>Verifier trace</span>
        <span style={{ marginLeft: 8, fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-soft)" }}>
          {tries} {tries === 1 ? "draft" : "drafts"}{meta.pass ? " · passed" : " · below bar"}
        </span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 12, color: avg >= 88 ? "var(--ok)" : avg >= 78 ? "var(--warn)" : "var(--ink-muted)" }}>{avg}%</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
        {rows.map((r) => {
          const tone = r.n >= 0.9 ? "var(--ok)" : r.n >= 0.78 ? "var(--warn)" : "var(--danger)";
          return (
            <div key={r.k}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={{ fontSize: 11.5, fontWeight: 500 }}>{r.k}</span>
                <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10.5, color: tone }}>{Math.round(r.n * 100)}</span>
              </div>
              <div className="bar-track" style={{ height: 4, marginTop: 4 }}>
                <div className="bar-fill" style={{ width: `${r.n * 100}%`, background: tone }} />
              </div>
            </div>
          );
        })}
      </div>
      {meta.reasons.length > 0 && (
        <ul style={{ margin: "10px 0 0", paddingLeft: 16, fontSize: 11, color: "var(--ink-muted)" }}>
          {meta.reasons.slice(0, 3).map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
    </div>
  );
}

/** Pill segmented control (status / mode toggles). */
export function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return <SegmentedControl value={value} onChange={onChange} options={options} label="Draft status or mode" />;
}

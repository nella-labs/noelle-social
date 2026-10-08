"use client";

import { useState, useTransition } from "react";
import { useMounted } from "@/lib/use-mounted";
import type { ApifyTokenSpend } from "@/lib/apify-spend-model";
import { ApifyExpenseHistory } from "./ApifyExpenseHistory";
import { formatCents } from "@/lib/utils";
import {
  addApifyTokensBulk,
  setApifyTokenInUse,
  removeApifyToken,
  testApifyToken,
  testAllApifyTokens,
  type ApifyTokenTestResult,
} from "./actions";

export type ApifyTokenSpendView = ApifyTokenSpend;

export interface ApifyTokenView {
  id: string;
  label: string;
  createdAt: string;
  exhaustedAt: string | null;
  /**
   * 'invalid' = Apify rejected it (401 — wrong/dead/banned account, replace it);
   * 'exhausted' = capped and still cooling; 'live' = healthy / retry-ready.
   */
  status: "live" | "exhausted" | "invalid";
  /** Retry/billing date label (e.g. "Jul 13") while exhausted; else null. */
  retryLabel: string | null;
  /** true = IN USE (agents rotate through it); false = SPARE (parked). */
  inUse: boolean;
}

interface Props {
  orgSlug: string;
  connections: ApifyTokenView[];
  spend: ApifyTokenSpendView[];
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--rule)",
  borderRadius: 6,
  background: "var(--paper)",
  fontFamily: "var(--mono)",
  fontSize: 13,
  resize: "vertical",
  minHeight: 64,
};

/**
 * Collapse a token bucket past this many rows — a 60-token in-use pool is a wall of
 * text otherwise. The rest hide behind a "View all N" toggle.
 */
const COLLAPSE_AT = 8;

/** Format a USD amount from the Apify limits endpoint (e.g. 3.5 -> "$3.50"). */
function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** One-line summary of a token health-check result, for inline display. */
function resultLine(r: ApifyTokenTestResult): { text: string; ok: boolean } {
  if (r.revalidated) {
    const budget =
      r.maxMonthlyUsageUsd !== undefined && r.monthlyUsageUsd !== undefined
        ? ` · ${usd(r.monthlyUsageUsd)} of ${usd(r.maxMonthlyUsageUsd)} used`
        : r.remainingUsd !== undefined
          ? ` · ${usd(r.remainingUsd)} left`
          : "";
    return { ok: true, text: `revalidated ✓ — alive${budget}` };
  }
  if (r.alive) {
    if (r.maxMonthlyUsageUsd !== undefined && r.monthlyUsageUsd !== undefined) {
      return { ok: true, text: `alive ✓ · ${usd(r.monthlyUsageUsd)} of ${usd(r.maxMonthlyUsageUsd)} used` };
    }
    if (r.remainingUsd !== undefined) return { ok: true, text: `alive ✓ · ${usd(r.remainingUsd)} left` };
    return { ok: true, text: "alive ✓" };
  }
  if (r.httpStatus === 401) return { ok: false, text: "invalid ✗ (HTTP 401)" };
  if (r.httpStatus === 0) return { ok: false, text: `error ✗ · ${r.error ?? "network"}` };
  return { ok: false, text: `error ✗ (HTTP ${r.httpStatus})` };
}

export function ApifyConnectionCard({ orgSlug, connections, spend }: Props) {
  const [value, setValue] = useState("");
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Summary line from the last bulk add (e.g. "Added 7 · 2 already in pool · 1 skipped").
  const [addNote, setAddNote] = useState<string | null>(null);
  // Per-token health-check results, keyed by credentialId. Populated by Test / Test all.
  const [results, setResults] = useState<Record<string, ApifyTokenTestResult>>({});
  // Which token is mid-test (null = none; "__all__" = the Test-all sweep).
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testing, startTest] = useTransition();
  // Each bucket collapses past COLLAPSE_AT rows; these toggle the full list.
  const [showAllInUse, setShowAllInUse] = useState(false);
  const [showAllSpare, setShowAllSpare] = useState(false);
  const mounted = useMounted();

  function onAdd() {
    setError(null);
    setAddNote(null);
    start(async () => {
      const res = await addApifyTokensBulk({ orgSlug, value });
      if (res.ok) {
        setValue("");
        const parts = [`Added ${res.added}`];
        if (res.alreadyPresent > 0) parts.push(`${res.alreadyPresent} already in pool`);
        if (res.skipped > 0) parts.push(`${res.skipped} skipped`);
        setAddNote(`${parts.join(" · ")} — parked as spare.`);
      } else setError(res.error.message);
    });
  }

  function onRemove(id: string) {
    setError(null);
    setBusyId(id);
    start(async () => {
      const res = await removeApifyToken({ orgSlug, credentialId: id });
      setBusyId(null);
      if (!res.ok) setError(res.error.message);
    });
  }

  function onMove(id: string, inUse: boolean) {
    setError(null);
    setBusyId(id);
    start(async () => {
      const res = await setApifyTokenInUse({ orgSlug, credentialId: id, inUse });
      setBusyId(null);
      if (!res.ok) setError(res.error.message);
    });
  }

  function onTest(id: string) {
    setError(null);
    setTestingId(id);
    startTest(async () => {
      const res = await testApifyToken({ orgSlug, credentialId: id });
      setTestingId(null);
      if (res.ok) setResults((r) => ({ ...r, [id]: res.result }));
      else setError(res.error.message);
    });
  }

  function onTestAll() {
    setError(null);
    setTestingId("__all__");
    startTest(async () => {
      const res = await testAllApifyTokens({ orgSlug });
      setTestingId(null);
      if (res.ok) {
        setResults((r) => {
          const next = { ...r };
          for (const one of res.results) next[one.credentialId] = one;
          return next;
        });
      } else setError(res.error.message);
    });
  }

  const spendByCred = new Map(spend.filter(s => s.source === "provider").map(s => [s.credentialId, s]));
  const canAdd = mounted && !pending && value.trim().length >= 12;

  const inUse = connections.filter((c) => c.inUse);
  const spare = connections.filter((c) => !c.inUse);
  const healthy = inUse.filter((c) => c.status === "live").length;

  // One token row, reused by both buckets. `move` is the promote/demote control.
  function tokenRow(c: ApifyTokenView, i: number, move: { label: string; inUse: boolean }) {
    const expense = spendByCred.get(c.id);
    const result = results[c.id];
    const line = result ? resultLine(result) : null;
    return (
      <div key={c.id} style={{ padding: "8px 0", borderTop: i === 0 ? 0 : "1px dashed var(--rule-soft)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            fontFamily: "var(--mono)",
            fontSize: 12,
            flexWrap: "wrap",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>{i + 1}.</span>
            <span style={{ color: "var(--ink-2)" }}>{c.label}</span>
            {c.status === "invalid" ? (
              <span
                className="tag tag-warn"
                style={{ color: "var(--rust, #b0461f)" }}
                title="Apify rejected this token (401) — the account is wrong, deleted, or banned. Replace it."
              >
                <span className="dot dot-warn" /> invalid · replace

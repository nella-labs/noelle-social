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
              </span>
            ) : c.status === "exhausted" ? (
              <span
                className="tag tag-warn"
                title={`Hit its monthly cap ${c.exhaustedAt ?? ""} — retries automatically on its billing reset`}
              >
                <span className="dot dot-warn" /> exhausted
                {c.retryLabel ? ` · retries ${c.retryLabel}` : ""}
              </span>
            ) : (
              <span className="tag tag-ok">
                <span className="dot dot-ok" /> live
              </span>
            )}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              style={{ color: "var(--ink-muted)" }}
              title={expense ? `Last reported Apify billing-cycle usage, fetched ${expense.fetchedAt}` : "No provider balance saved. Test this token to fetch its usage."}
            >
              {expense ? formatCents(expense.cents) : "Not fetched"}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onTest(c.id)}
              disabled={!mounted || testing}
              title="Health-check this token against Apify (live + remaining budget)"
            >
              {testing && testingId === c.id ? "Testing…" : "Test"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onMove(c.id, move.inUse)}
              disabled={pending && busyId === c.id}
              title={
                move.inUse
                  ? "Promote this spare token into the agents' rotation"
                  : "Park this token as spare — the agents stop using it"
              }
            >
              {pending && busyId === c.id ? "…" : move.label}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onRemove(c.id)}
              disabled={pending && busyId === c.id}
              title="Remove this token from the pool"
            >
              {pending && busyId === c.id ? "…" : "Remove"}
            </button>
          </span>
        </div>
        {line ? (
          <div
            style={{
              marginTop: 6,
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              color: line.ok ? "var(--green, #2f7d54)" : "var(--rust, #b0461f)",
              paddingLeft: 18,
            }}
          >
            {line.text}
          </div>
        ) : null}
      </div>
    );
  }

  // A token bucket rendered with a "View all N" / "Show fewer" collapse past
  // COLLAPSE_AT rows, so a big pool doesn't run forever down the page.
  function bucketList(
    items: ApifyTokenView[],
    expanded: boolean,
    setExpanded: (v: boolean) => void,
    move: { label: string; inUse: boolean },
  ) {
    const visible = expanded ? items : items.slice(0, COLLAPSE_AT);
    const hidden = items.length - visible.length;
    return (
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column" }}>
        {visible.map((c, i) => tokenRow(c, i, move))}
        {items.length > COLLAPSE_AT ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setExpanded(!expanded)}
            style={{ marginTop: 10, alignSelf: "flex-start" }}
          >
            {expanded ? "Show fewer" : `View all ${items.length} (+${hidden} more)`}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-h">
        <h3>Apify</h3>
        {inUse.length === 0 ? (
          <span className="tag tag-warn">
            <span className="dot dot-warn" /> none in use
          </span>
        ) : (
          <span className={healthy > 0 ? "tag tag-ok" : "tag tag-warn"}>
            <span className={healthy > 0 ? "dot dot-ok" : "dot dot-warn"} />
            {healthy}/{inUse.length} live
          </span>
        )}
      </div>
      <div style={{ color: "var(--ink-muted)", fontSize: 12.5, marginBottom: 12, maxWidth: "60ch" }}>
        Tokens used to fetch posts and comments. Add <strong>spare</strong> tokens
        below, then move them into <strong>in use</strong>. Usage comes from Apify
        and stays visible after a token is retired.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <textarea
          placeholder={"apify_api_…\nPaste one or more tokens — one per line, or comma/space separated."}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={!mounted || pending}
          style={inputStyle}
          rows={3}
        />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onAdd} disabled={!canAdd}>
            {pending && !busyId ? "Adding…" : "Add to spare"}
          </button>
        </div>
      </div>
      {addNote ? (
        <div style={{ color: "var(--green, #2f7d54)", fontSize: 12, marginTop: 8 }}>{addNote}</div>
      ) : null}
      {error ? (
        <div style={{ color: "var(--rust, #b0461f)", fontSize: 12, marginTop: 8 }}>{error}</div>
      ) : null}

      {/* IN USE — the live rotation the agents pull from. */}
      <div style={{ marginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div className="eyebrow">In use · agents rotate through these</div>
          {inUse.length > 0 ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={onTestAll}
              disabled={!mounted || testing}
              title="Health-check every token (live + remaining budget). Resurrects any wrongly-retired token that tests alive."
            >
              {testing && testingId === "__all__" ? "Testing…" : "Test all"}
            </button>
          ) : null}
        </div>
        {inUse.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 8 }}>
            No tokens in use — the agents fall back to the env token. Move a spare token
            in to give them a dedicated pool.
          </div>
        ) : (
          bucketList(inUse, showAllInUse, setShowAllInUse, { label: "Move to spare", inUse: false })
        )}
      </div>

      {/* SPARE — parked tokens the agents never touch until promoted. */}
      {spare.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <div className="eyebrow">Spare · parked ({spare.length})</div>
          {bucketList(spare, showAllSpare, setShowAllSpare, { label: "Move to in use", inUse: true })}
        </div>
      ) : null}

      <ApifyExpenseHistory spend={spend} />
    </div>
  );
}

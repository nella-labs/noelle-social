"use client";

import { useCallback, useState } from "react";

import { HiddenFormValue } from "./HiddenFormValue";

/**
 * Monthly budget cap picker.
 *
 * The previous control was a 1px-per-$5 range slider spanning $25–$2,000.
 * Founders couldn't land on a round number — every drag wobbled between
 * $295 and $310 — and there was no signposting for typical caps. This
 * component is a small dollar number input plus chip presets for the
 * common buckets ($25 floor, $100 hobby, $500 startup, $1k team, $2k
 * ceiling), with the same hidden form field name (`budgetCapCents`)
 * the action expects.
 */

const PRESETS_CENTS = [2_500, 10_000, 50_000, 100_000, 200_000] as const;

export function BudgetCapField({
  defaultCents,
  minCents,
  maxCents,
  stepCents,
  disabled,
}: {
  defaultCents: number;
  minCents: number;
  maxCents: number;
  stepCents: number;
  disabled?: boolean;
}) {
  const [cents, setCents] = useState(defaultCents);
  const reset = useCallback(() => setCents(defaultCents), [defaultCents]);

  function clampToStep(raw: number): number {
    if (!Number.isFinite(raw)) return minCents;
    const bounded = Math.min(maxCents, Math.max(minCents, Math.round(raw)));
    return Math.round(bounded / stepCents) * stepCents;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <HiddenFormValue name="budgetCapCents" value={cents} onReset={reset} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 14,
            color: "var(--ink-muted)",
          }}
        >
          $
        </span>
        <input
          type="number"
          min={minCents / 100}
          max={maxCents / 100}
          step={stepCents / 100}
          value={(cents / 100).toFixed(2)}
          disabled={disabled}
          inputMode="decimal"
          onChange={(e) => {
            const dollars = Number(e.target.value);
            setCents(clampToStep(dollars * 100));
          }}
          style={{
            width: "100%",
            maxWidth: 120,
            minWidth: 0,
            padding: "8px 10px",
            borderRadius: 7,
            fontFamily: "var(--mono)",
            fontSize: 14,
            background: "var(--paper)",
            color: "var(--ink)",
            border: "none",
            boxShadow: "0 0 0 0.5px var(--rule)",
          }}
        />
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            color: "var(--ink-muted)",
          }}
        >
          per month · min ${minCents / 100} · max ${maxCents / 100}
        </span>
      </div>

      <div
        className="tweak-radio"
        style={{ flexWrap: "wrap", gap: 6 }}
        aria-label="Budget cap presets"
      >
        {PRESETS_CENTS.map((preset) => {
          const active = cents === preset;
          return (
            <button
              key={preset}
              type="button"
              disabled={disabled}
              onClick={() => setCents(preset)}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                fontSize: 11.5,
                fontFamily: "var(--mono)",
                color: active ? "var(--ink)" : "var(--ink-muted)",
                background: active ? "var(--paper)" : "transparent",
                boxShadow: active
                  ? "0 0 0 0.5px var(--rule)"
                  : "0 0 0 0.5px var(--rule-soft)",
                cursor: disabled ? "not-allowed" : "pointer",
                border: "none",
              }}
            >
              ${preset / 100}
            </button>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import { useCallback, useState } from "react";

import { HiddenFormValue } from "./HiddenFormValue";

/**
 * Discrete percent picker.
 *
 * Used for the cap-alert threshold, where the underlying range was
 * 50%–100% in 5-point steps — eleven discrete options. Chips make the
 * common buckets (50 / 75 / 90 / 100) obvious and snap precisely. The
 * picker posts the integer percent through a hidden input under the
 * given `name`.
 */
export function PercentPicker({
  name,
  options,
  defaultValue,
  disabled,
}: {
  name: string;
  options: readonly number[];
  defaultValue: number;
  disabled?: boolean;
}) {
  // If the persisted value isn't one of the offered chips (e.g. a
  // legacy 65% saved from the old slider), surface it as a selected
  // chip too so the user sees what's stored. They can then click any
  // of the standard buckets to change it.
  const seen = new Set<number>([...options, defaultValue]);
  const chips = Array.from(seen).sort((a, b) => a - b);

  const [value, setValue] = useState<number>(defaultValue);
  const reset = useCallback(() => setValue(defaultValue), [defaultValue]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <HiddenFormValue name={name} value={value} onReset={reset} />
      <div
        className="tweak-radio"
        style={{ flexWrap: "wrap", gap: 6 }}
        role="radiogroup"
        aria-label="Cap alert threshold"
      >
        {chips.map((pct) => {
          const active = pct === value;
          return (
            <button
              key={pct}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => setValue(pct)}
              style={{
                padding: "4px 12px",
                borderRadius: 6,
                fontSize: 12,
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
              {pct}%
            </button>
          );
        })}
      </div>
    </div>
  );
}

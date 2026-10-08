"use client";

import { useCallback, useState } from "react";

import { HiddenFormValue } from "./HiddenFormValue";

/**
 * Integer stepper with +/- buttons and a centered display.
 *
 * Used for small whole-number knobs (e.g. max-per-hour 1-30) where a
 * range slider was the wrong control — scrubbing 30 positions across
 * the slider's pixel width meant founders kept landing on the wrong
 * integer. The component posts the value through a hidden input under
 * the given `name`, so the existing server action validation works
 * unchanged.
 */
export function StepperField({
  name,
  min,
  max,
  step,
  defaultValue,
  disabled,
  unitLabel,
}: {
  name: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  disabled?: boolean;
  unitLabel?: string;
}) {
  const [value, setValue] = useState<number>(defaultValue);
  const reset = useCallback(() => setValue(defaultValue), [defaultValue]);

  const clamp = (n: number) =>
    Math.min(max, Math.max(min, Math.round(n / step) * step));

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <HiddenFormValue name={name} value={value} onReset={reset} />
      <button
        type="button"
        disabled={disabled || value <= min}
        onClick={() => setValue((v) => clamp(v - step))}
        aria-label="Decrease"
        className="stepper-btn"
        style={{
          width: 30,
          height: 30,
          borderRadius: 7,
          border: "none",
          background: "var(--paper)",
          boxShadow: "0 0 0 0.5px var(--rule)",
          color: "var(--ink)",
          fontFamily: "var(--mono)",
          fontSize: 16,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        −
      </button>
      <div
        style={{
          minWidth: 70,
          textAlign: "center",
          padding: "6px 10px",
          borderRadius: 7,
          background: "var(--paper)",
          boxShadow: "0 0 0 0.5px var(--rule)",
          fontFamily: "var(--mono)",
          fontSize: 13,
          color: "var(--ink)",
        }}
        aria-live="polite"
      >
        {value}
        {unitLabel ? (
          <span style={{ color: "var(--ink-muted)" }}>{unitLabel}</span>
        ) : null}
      </div>
      <button
        type="button"
        disabled={disabled || value >= max}
        onClick={() => setValue((v) => clamp(v + step))}
        aria-label="Increase"
        className="stepper-btn"
        style={{
          width: 30,
          height: 30,
          borderRadius: 7,
          border: "none",
          background: "var(--paper)",
          boxShadow: "0 0 0 0.5px var(--rule)",
          color: "var(--ink)",
          fontFamily: "var(--mono)",
          fontSize: 16,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        +
      </button>
      <span
        style={{
          marginLeft: 6,
          fontSize: 11.5,
          color: "var(--ink-muted)",
          fontFamily: "var(--mono)",
        }}
      >
        range {min}–{max}
      </span>
    </div>
  );
}

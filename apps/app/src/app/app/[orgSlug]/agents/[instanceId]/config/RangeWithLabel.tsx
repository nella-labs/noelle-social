"use client";

import { useCallback, useRef, useState } from "react";
import { useFormReset } from "./HiddenFormValue";

export type RangeFormat = "usd-cents" | "duration" | "per-hour" | "percent";

function formatValue(value: number, format: RangeFormat): string {
  switch (format) {
    case "usd-cents":
      return `$${(value / 100).toFixed(2)}`;
    case "duration": {
      if (value < 60) return `${value}s`;
      const m = Math.floor(value / 60);
      const s = value % 60;
      return s === 0 ? `${m} min` : `${m} min ${s}s`;
    }
    case "per-hour":
      return `${value}/hr`;
    case "percent":
      return `${value}%`;
  }
}

/**
 * Range input with a live value label.
 *
 * Server-rendered ranges look interactive (the thumb drags) but their label
 * is frozen at `defaultValue` — drag the budget slider and nothing visibly
 * changes, even though the form would post the dragged value on submit.
 * That confused founders into thinking the budget cap couldn't be modified.
 * Bumping this to a client component with `useState` keeps the slider as the
 * source of truth on submit (the native `name` attribute still drives form
 * data) while mirroring the current value into the label as you drag.
 *
 * `format` is a string (not a function) so the prop is serializable across
 * the Server → Client Component boundary.
 */
export function RangeWithLabel({
  name,
  min,
  max,
  step,
  defaultValue,
  disabled,
  format,
}: {
  name: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  disabled?: boolean;
  format: RangeFormat;
}) {
  const [value, setValue] = useState(defaultValue);
  const ref = useRef<HTMLInputElement>(null);
  useFormReset(ref, useCallback(() => setValue(defaultValue), [defaultValue]));
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <input
        ref={ref}
        type="range"
        name={name}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        disabled={disabled}
        style={{ flex: 1, accentColor: "var(--accent)" }}
      />
      <span
        aria-live="polite"
        style={{
          minWidth: 70,
          textAlign: "right",
          fontFamily: "var(--mono)",
          fontSize: 12.5,
          color: "var(--ink)",
        }}
      >
        {formatValue(value, format)}
      </span>
    </div>
  );
}

"use client";

import { useCallback, useRef, useState } from "react";
import { useFormReset } from "./HiddenFormValue";

/**
 * Pill switch that posts as a checkbox. Replaces the old "checkbox + Off label"
 * field where the label never updated because it read `defaultChecked` instead
 * of the live state — operators couldn't tell whether the toggle was on or off.
 *
 * The native checkbox is visually hidden but still ships its value in the form
 * submission so the existing server action keeps working unchanged.
 */
export function SwitchField({
  name,
  defaultChecked,
  disabled,
  onLabel = "On",
  offLabel = "Off",
}: {
  name: string;
  defaultChecked?: boolean;
  disabled?: boolean;
  onLabel?: string;
  offLabel?: string;
}) {
  const [checked, setChecked] = useState<boolean>(!!defaultChecked);
  const ref = useRef<HTMLInputElement>(null);
  useFormReset(ref, useCallback(() => setChecked(!!defaultChecked), [defaultChecked]));

  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        userSelect: "none",
      }}
    >
      <input
        ref={ref}
        type="checkbox"
        name={name}
        checked={checked}
        disabled={disabled}
        value="true"
        onChange={(e) => setChecked(e.currentTarget.checked)}
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
        }}
      />
      <span
        aria-hidden="true"
        style={{
          position: "relative",
          width: 40,
          height: 22,
          borderRadius: 999,
          background: checked ? "var(--accent)" : "var(--paper-2)",
          boxShadow: "inset 0 0 0 0.5px var(--rule)",
          transition: "background 160ms ease",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 20 : 2,
            width: 18,
            height: 18,
            borderRadius: 999,
            background: "var(--paper)",
            boxShadow: "0 1px 2px rgba(0,0,0,0.18)",
            transition: "left 160ms ease",
          }}
        />
      </span>
      <span
        style={{
          fontSize: 12.5,
          fontFamily: "var(--mono)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: checked ? "var(--ink)" : "var(--ink-muted)",
          minWidth: 28,
        }}
      >
        {checked ? onLabel : offLabel}
      </span>
    </label>
  );
}

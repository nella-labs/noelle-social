"use client";

import { type MouseEvent } from "react";
import { useCopy } from "@/lib/use-copy";

/**
 * One-click copy button that bounces and turns ok-green when the text
 * lands on the clipboard. Ported from screens.jsx `CopyButton`.
 *
 * The width is reserved for the wider "✓ Copied" footprint so the row
 * never reflows; the button itself starts compact and grows on copy with
 * a soft scale pop. Clipboard + auto-clear live in the shared `useCopy` hook.
 */
interface Props {
  text: string;
  /** Optional callback fired when the copy succeeds. */
  onCopied?: () => void;
  /** Label for the default state ("Copy" by default). */
  label?: string;
}

export function CopyButton({ text, onCopied, label = "Copy" }: Props) {
  const { copiedKey, copy, copyError } = useCopy();
  const copied = copiedKey !== null;

  const handle = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (await copy(text)) onCopied?.();
  };

  return (
    <div style={{ minWidth: 96, display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 6 }}>
      <button
        type="button"
        onClick={handle}
        aria-label={copied ? "Copied to clipboard" : "Copy to clipboard"}
        style={{
          height: 28,
          border: 0,
          borderRadius: 8,
          padding: copied ? "0 14px" : "0 10px",
          fontFamily: "var(--body)",
          fontSize: copied ? 12.5 : 12,
          fontWeight: 500,
          letterSpacing: copied ? "0.01em" : "0",
          background: copied ? "var(--ok)" : "var(--ink)",
          color: copied ? "#fff" : "var(--paper)",
          boxShadow: copied
            ? "0 0 0 0.5px var(--ok), 0 8px 20px -8px color-mix(in oklch, var(--ok) 70%, transparent)"
            : "0 0 0 0.5px var(--ink), 0 2px 6px -3px rgba(31,26,18,.35)",
          transform: copied ? "scale(1.06)" : "scale(1)",
          transformOrigin: "right center",
          transition:
            "transform .22s cubic-bezier(.34,1.56,.64,1), background .15s, box-shadow .2s, padding .18s, font-size .18s",
          whiteSpace: "nowrap",
          cursor: "pointer",
        }}
      >
        {copied ? "✓ Copied" : label}
      </button>
      {copyError ? <span role="status" className="tag" style={{ color: "var(--danger)", fontSize: 11 }}>{copyError}</span> : null}
    </div>
  );
}

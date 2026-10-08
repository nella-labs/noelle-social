"use client";

import { useState, useTransition } from "react";
import { setLlmBackend } from "@/app/app/[orgSlug]/admin/infrastructure/actions";

type Backend = "aws" | "claude";

const OPTIONS: { value: Backend; label: string; note: string }[] = [
  { value: "claude", label: "Claude", note: "Max subscription · $0" },
  { value: "aws", label: "AWS Bedrock", note: "per-token" },
];

/**
 * Two-state segmented control for the global agent-LLM backend
 * (noelle.organizations.llm_backend). Calls the admin-gated `setLlmBackend`
 * server action inside a transition; optimistic switch, rolls back on error.
 */
export function LlmBackendToggle({
  orgSlug,
  initial,
}: {
  orgSlug: string;
  initial: Backend;
}) {
  const [backend, setBackend] = useState<Backend>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function choose(next: Backend) {
    if (next === backend || pending) return;
    const prev = backend;
    setBackend(next); // optimistic
    setError(null);
    startTransition(() => {
      setLlmBackend({ orgSlug, backend: next }).then((res) => {
        if (!res.ok) {
          setBackend(prev); // roll back
          setError(res.error.message || "Failed to update backend.");
        }
      });
    });
  }

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Agent model backend"
        style={{
          display: "inline-flex",
          gap: 2,
          padding: 4,
          borderRadius: 10,
          background: "var(--paper-2)",
          boxShadow: "inset 0 0 0 0.5px var(--rule)",
          opacity: pending ? 0.7 : 1,
          transition: "opacity .15s",
        }}
      >
        {OPTIONS.map((opt) => {
          const on = opt.value === backend;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={pending}
              onClick={() => choose(opt.value)}
              style={{
                display: "inline-flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 2,
                minWidth: 150,
                padding: "10px 14px",
                borderRadius: 8,
                border: 0,
                cursor: pending ? "default" : "pointer",
                textAlign: "left",
                background: on ? "var(--paper)" : "transparent",
                color: on ? "var(--ink)" : "var(--ink-muted)",
                boxShadow: on
                  ? "0 0 0 0.5px var(--rule), 0 1px 2px rgba(31,26,18,.05)"
                  : "none",
                transition: "background .15s, color .15s",
              }}
            >
              <span style={{ fontSize: 13.5, fontWeight: 500 }}>{opt.label}</span>
              <span
                className="mono"
                style={{
                  fontSize: 10.5,
                  letterSpacing: "0.04em",
                  color: on ? "var(--accent)" : "var(--ink-soft)",
                }}
              >
                {opt.note}
              </span>
            </button>
          );
        })}
      </div>
      <div
        className="mono"
        style={{
          marginTop: 10,
          fontSize: 11,
          color: error ? "var(--bad)" : "var(--ink-soft)",
          letterSpacing: "0.04em",
        }}
        aria-live="polite"
      >
        {error
          ? error
          : pending
            ? "Saving…"
            : `Active backend: ${backend === "claude" ? "Claude (claude -p)" : "AWS Bedrock"}`}
      </div>
    </div>
  );
}

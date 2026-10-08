"use client";

import * as React from "react";
import type { PatternAlertView } from "@noelle/contracts";
import { X, Sparkles, Undo2, Check, ArrowRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import styles from "./pattern-alert.module.css";
import {
  revertPatternAlert,
  refinePatternAlert,
  acknowledgePatternAlert,
} from "@/app/app/[orgSlug]/approvals/actions";

export interface PatternAlertItem extends Omit<PatternAlertView, "createdAt"> {
  refineNote: string | null;
}

interface Props {
  orgSlug: string;
  alerts: PatternAlertItem[];
}

const SEVERITY_DOT: Record<PatternAlertItem["severity"], string> = {
  high: styles.high,
  medium: styles.medium,
  low: styles.low,
};

/**
 * The Pattern Breaker popup. When the breaker spots a structural habit repeated
 * across the operator's recent posts, it surfaces here over the approvals page:
 * what the habit is, how often it showed up, an example, and — because the rule
 * is ALREADY live in the drafter — a Revert (undo it) and a Refine (have AI
 * rewrite the rule, optionally from a note). One card at a time; dismiss to see
 * the next. Polls so a refine result appears without a manual reload.
 */
export function PatternAlertBanner({ orgSlug, alerts }: Props) {
  const [queue, setQueue] = React.useState(alerts);
  const [expanded, setExpanded] = React.useState(false);
  const reviewControl = React.useRef<HTMLButtonElement>(null);
  const collapseControl = React.useRef<HTMLButtonElement>(null);
  const focusAfterToggle = React.useRef(false);
  React.useEffect(() => {
    if (!focusAfterToggle.current) return;
    focusAfterToggle.current = false;
    (expanded ? collapseControl : reviewControl).current?.focus();
  }, [expanded]);
  const togglePresentation = (next: boolean) => {
    focusAfterToggle.current = true;
    setExpanded(next);
  };
  const [refineFor, setRefineFor] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const reserved = React.useRef(false);
  const generation = React.useRef(0);
  React.useEffect(() => {
    if (!busy) reserved.current = false;
  }, [busy]);
  React.useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  // Keep in sync with fresh server data (the page revalidates / auto-refreshes).
  React.useEffect(() => {
    generation.current++;
    setQueue(alerts);
  }, [alerts]);

  const current = queue[0];
  if (!current) return null;

  const remove = (id: string) => {
    setQueue((q) => q.filter((a) => a.id !== id));
    setExpanded(false);
    setRefineFor(null);
    setNote("");
    setError(null);
  };

  type ActionReceipt = {
    ok: boolean;
    status?: string;
    refineRequestId?: string | null;
    error?: { message: string };
  };
  const run = (fn: () => Promise<ActionReceipt>, onOk: (receipt: ActionReceipt) => void) => {
    if (reserved.current) return;
    reserved.current = true;
    setBusy(true);
    const capturedGeneration = generation.current;
    setError(null);
    startTransition(async () => {
      try {
        const result = await fn();
        if (capturedGeneration !== generation.current) return;
        if (result.ok) onOk(result);
        else setError(result.error?.message ?? "Something went wrong.");
      } catch (failure) {
        if (capturedGeneration === generation.current)
          setError(failure instanceof Error ? failure.message : "Something went wrong.");
      } finally {
        setBusy(false);
      }
    });
  };
  const onRevert = () =>
    run(
      () => revertPatternAlert({ orgSlug, alertId: current.id }),
      () => remove(current.id),
    );
  const onAcknowledge = () =>
    run(
      () => acknowledgePatternAlert({ orgSlug, alertId: current.id }),
      () => remove(current.id),
    );
  const onRefine = () =>
    run(
      () =>
        refinePatternAlert({
          orgSlug,
          alertId: current.id,
          note: note.trim() || undefined,
          ...(current.refineRequestId && (current.status === "refining" || current.refineFailed)
            ? { expectedRequestId: current.refineRequestId }
            : {}),
        }),
      (receipt) => {
        if (receipt.status !== "refining" || !receipt.refineRequestId) {
          setError("The refinement was not acknowledged. Refresh to check its status.");
          return;
        }
        setRefineFor(null);
        setQueue((q) =>
          q.map((a) =>
            a.id === current.id
              ? {
                  ...a,
                  status: "refining",
                  refineRequestId: receipt.refineRequestId,
                  refineClaimed: false,
                  refineFailed: false,
                }
              : a,
          ),
        );
      },
    );

  const isRefining = current.status === "refining";
  const isRefined = current.status === "refined";
  const isRetry = isRefining || current.refineFailed;
  const disabled = pending || busy;

  if (!expanded) {
    return (
      <div role="alert" className={`${styles.shell} ${styles.compact}`}>
        <div className={styles.compactCopy}>
          <PatternLabel count={queue.length} severity={current.severity} refined={isRefined} />
          <span className={styles.compactTitle} title={current.patternName}>{current.patternName}</span>
        </div>
        <button ref={reviewControl} type="button" className="btn btn-sm btn-ghost"
          aria-expanded={false} onClick={() => togglePresentation(true)}>Review pattern</button>
      </div>
    );
  }

  return (
    <div
      role="alertdialog"
      aria-labelledby="pattern-alert-title"
      aria-describedby="pattern-alert-desc"
      className={styles.shell}
    >
      <div
        className={styles.card}
      >
        <div className={styles.header}>
          <PatternLabel count={queue.length} severity={current.severity} refined={isRefined} />
          <div className={styles.headerActions}>
            <button ref={collapseControl} type="button" className={styles.close}
              aria-label="Collapse pattern" title="Collapse pattern" aria-expanded={true}
              onClick={() => togglePresentation(false)}><ChevronDown size={16} aria-hidden="true" /></button>
            <button
              type="button"
              onClick={() => !disabled && onAcknowledge()}
              className={styles.close}
              aria-label="Dismiss (keep the rule)"
              disabled={disabled}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

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

        <h2 id="pattern-alert-title" className={styles.title}>
          {current.patternName}
        </h2>
        <p id="pattern-alert-desc" className={styles.description}>
          {current.description}
        </p>
        <p className={styles.meta}>
          Observed in {current.frequencyCount} of {current.windowSize} analyzed posts. The current
          rule guides the drafter.
        </p>

        {current.examples[0]?.snippet ? (
          <blockquote className={styles.example}>
            &ldquo;{current.examples[0].snippet}&rdquo;
          </blockquote>
        ) : null}

        {current.suggestion?.trim() ? (
          <div className={styles.suggestion}>
            <p className={styles.suggestionLabel}>
              <ArrowRight className="h-3 w-3" aria-hidden />
              Try instead
            </p>
            <p className={styles.suggestionCopy}>{current.suggestion.trim()}</p>
          </div>
        ) : null}

        {(isRefining || isRefined) && current.refineNote?.trim() ? (
          <p className={styles.note}>
            <strong>You told the drafter:</strong>{" "}
            {current.refineNote.trim()}
          </p>
        ) : null}

        {isRefined && current.ruleInstruction ? (
          <p className={styles.note}>
            <strong>Refined rule:</strong>{" "}
            {current.ruleInstruction}
          </p>
        ) : null}

        {refineFor === current.id ? (
          <div className={styles.refine}>
            <label
              htmlFor="refine-note"
            >
              How should the AI refine this? (optional)
            </label>
            <Textarea
              id="refine-note"
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 600))}
              placeholder="e.g. it's fine when it's a genuine congrats on a launch"
              disabled={disabled}
              className="mt-1 min-h-16"
            />
          </div>
        ) : null}

        {isRefining ? (
          <p className={styles.status}>
            {current.refineClaimed
              ? "Awaiting refinement result. An uncertain attempt will not retry automatically."
              : "Queued for refinement."}
          </p>
        ) : current.refineFailed ? (
          <p className={styles.error}>
            Refinement did not produce a usable result. The original rule is unchanged.
          </p>
        ) : null}
        {isRetry && refineFor === current.id ? (
          <p className={styles.status}>
            Retry requests one new refinement attempt and replaces the previous pending request.
          </p>
        ) : null}

        {error ? <p className={styles.error}>{error}</p> : null}

        <div className={styles.actions}>
          {refineFor === current.id ? (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRefineFor(null)}
                disabled={disabled}
              >
                Cancel
              </Button>
              <Button type="button" variant="primary" onClick={onRefine} disabled={disabled}>
                <Sparkles className="mr-1 h-3.5 w-3.5" />
                {disabled ? "Sending…" : isRetry ? "Retry with AI" : "Refine with AI"}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={onRevert} disabled={disabled}>
                <Undo2 className="mr-1 h-3.5 w-3.5" />
                Revert
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRefineFor(current.id)}
                disabled={disabled || (isRefining && !current.refineRequestId)}
              >
                <Sparkles className="mr-1 h-3.5 w-3.5" />
                {isRetry ? "Retry refinement" : "Refine"}
              </Button>
              <Button type="button" variant="primary" onClick={onAcknowledge} disabled={disabled}>
                <Check className="mr-1 h-3.5 w-3.5" />
                Keep
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PatternLabel({ count, severity, refined }: { count: number; severity: PatternAlertItem["severity"]; refined: boolean }) {
  return (
    <div className={styles.label}>
      <span className={`${styles.dot} ${SEVERITY_DOT[severity]}`} aria-hidden="true" />
      <span>Pattern breaker · {count}</span>
      {refined ? <span className={styles.refined}><Check size={10} aria-hidden="true" /> Refined</span> : null}
    </div>
  );
}

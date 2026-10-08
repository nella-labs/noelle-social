"use client";

import { CheckCheck, Send, SkipForward } from "lucide-react";
import styles from "./review-inbox.module.css";

interface Props {
  count: number;
  lastN: number;
  selectableCount: number;
  pending: boolean;
  onSelectAll: () => void;
  onSelectLast: () => void;
  onLastNChange: (value: number) => void;
  onClear: () => void;
  onSkip: () => void;
  onQueue?: () => void;
  message: { ok: boolean; text: string } | null;
}

export function InboxSelectionControls({ count, lastN, selectableCount, pending, onSelectAll, onSelectLast, onLastNChange, onClear, onSkip, onQueue, message }: Props) {
  return (
    <div className={styles.selection} data-selected={count > 0 || undefined}>
      <span className={styles.selectedCount}>{count} selected</span>
      <button type="button" className="btn btn-xs btn-ghost" onClick={onSelectAll} disabled={pending || selectableCount === 0}>
        <CheckCheck size={13} aria-hidden="true" /><span>Select all</span>
      </button>
      <span className={styles.lastSelection}>
        <button type="button" className="btn btn-xs btn-ghost" onClick={onSelectLast} disabled={pending || selectableCount === 0}>Select last</button>
        <input type="number" aria-label="Number of drafts to select" min={1} max={selectableCount || 1} value={lastN}
          onChange={(event) => onLastNChange(Math.max(1, Number(event.target.value) || 1))} />
      </span>
      {count > 0 ? <button type="button" className="btn btn-xs btn-ghost" onClick={onClear} disabled={pending}>Clear</button> : null}
      <div className={styles.selectionActions}>
        {onQueue ? (
          <button type="button" className="btn btn-xs btn-primary" onClick={onQueue} disabled={pending || count === 0}
            title="Queue selected replies for staggered auto-send">
            <Send size={13} aria-hidden="true" /> {pending ? "Queuing…" : "Auto-send selected"}
          </button>
        ) : null}
        <button type="button" className="btn btn-xs btn-ghost" onClick={onSkip} disabled={pending || count === 0}
          title="Skip selected drafts. Restore them from Status → Skipped.">
          <SkipForward size={13} aria-hidden="true" /> {pending ? "…" : "Skip selected"}
        </button>
      </div>
      {message ? <span role="status" className={styles.message} data-error={!message.ok || undefined}>{message.text}</span> : null}
    </div>
  );
}

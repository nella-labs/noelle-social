"use client";

import type { InboxMode } from "@/lib/hooks/useInboxMode";
import styles from "./stream-controls.module.css";

const OPTIONS: { value: InboxMode; label: string; hint: string }[] = [
  { value: "review", label: "Review", hint: "Open each draft for a full review" },
  { value: "speedrun", label: "Speedrun", hint: "Review and copy drafts in one list" },
];

interface Props {
  mode: InboxMode;
  setMode: (next: InboxMode) => void;
}

export function ModeToggle({ mode, setMode }: Props) {
  return (
    <div role="group" aria-label="Approvals view mode" className={styles.mode}>
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={mode === option.value}
          title={option.hint}
          onClick={() => setMode(option.value)}
          className={styles.modeButton}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

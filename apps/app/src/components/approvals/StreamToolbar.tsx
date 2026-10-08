"use client";

import type { ReactNode } from "react";
import { AppLink as Link } from "@/components/nav/AppLink";
import type { InboxMode } from "@/lib/hooks/useInboxMode";
import { ClipboardCheck, Settings2 } from "lucide-react";
import { ModeToggle } from "./ModeToggle";
import styles from "./stream-controls.module.css";

interface Props {
  count: number;
  title: string;
  description: string;
  mode: InboxMode;
  setMode: (next: InboxMode) => void;
  configureHref: string;
  children?: ReactNode;
}

export function StreamToolbar({ count, title, description, mode, setMode, configureHref, children }: Props) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.summary}>
        <span className={styles.quantity}><ClipboardCheck size={20} aria-hidden="true" /></span>
        <div className={styles.summaryText}>
          <strong>{title} · {count}</strong>
          <span>{description}</span>
        </div>
      </div>
      <div className={styles.actions}>
        {children}
        <ModeToggle mode={mode} setMode={setMode} />
        <Link href={configureHref} className="btn btn-sm btn-ghost">
          <Settings2 size={14} aria-hidden="true" /> Configure agent
        </Link>
      </div>
    </div>
  );
}

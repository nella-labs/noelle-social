import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import styles from "./growth.module.css";

export function WorkspacePanel({ title, meta, action, children, className = "" }: {
  title: string; meta?: string; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <Card className={`${styles.panel} ${className}`}>
      <header className={styles.panelHeader}>
        <div><h2>{title}</h2>{meta && <p>{meta}</p>}</div>
        {action}
      </header>
      {children}
    </Card>
  );
}

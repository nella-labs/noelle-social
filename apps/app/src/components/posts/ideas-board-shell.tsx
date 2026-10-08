"use client";

import { Lightbulb, Minus, Plus, Search, PenLine, Zap } from "lucide-react";
import styles from "./ideas.module.css";

const MIN_IDEAS = 1;
const MAX_IDEAS = 12;
export const IDEAS_MANUAL_MAX = 3000;

export function GenerateStepper({ n, setN, onGenerate, busy }: {
  n: number; setN: (n: number) => void; onGenerate: () => void; busy: boolean;
}) {
  return (
    <div className={styles.generateActions}>
      <div className={styles.stepper}>
        <button type="button" onClick={() => setN(Math.max(MIN_IDEAS, n - 1))} disabled={busy || n <= MIN_IDEAS} aria-label="Fewer ideas"><Minus size={14} /></button>
        <span aria-live="polite">{n}</span>
        <button type="button" onClick={() => setN(Math.min(MAX_IDEAS, n + 1))} disabled={busy || n >= MAX_IDEAS} aria-label="More ideas"><Plus size={14} /></button>
      </div>
      <button className="btn btn-primary" onClick={onGenerate} disabled={busy}>{busy ? "Generating…" : `Generate ${n}`}</button>
    </div>
  );
}

export function IdeasGenerateBar({ eyebrow, description, count, setCount, onGenerate, onBatch, genBusy,
  own, setOwn, onAddOwn, ownPlaceholder, ownBusy, ownActionLabel = "Add & draft" }: {
  eyebrow: string; description: string; count: number; setCount: (n: number) => void;
  onGenerate: () => void; onBatch: () => void; genBusy: boolean;
  own: string; setOwn: (value: string) => void; onAddOwn: () => void;
  ownPlaceholder: string; ownBusy: boolean; ownActionLabel?: string;
}) {
  return (
    <div className={styles.startGrid}>
      <section className={styles.startPanel}>
        <div className={styles.panelHeading}><span className={styles.headingIcon}><Lightbulb size={19} aria-hidden /></span><h3>{eyebrow}</h3></div>
        <p className={styles.description}>{description}</p>
        <div className={styles.panelActions}><GenerateStepper n={count} setN={setCount} onGenerate={onGenerate} busy={genBusy} /><button className="btn btn-sm" onClick={onBatch} disabled={genBusy}><Zap size={13} aria-hidden />Weekly batch</button></div>
      </section>
      <section className={`${styles.startPanel} ${styles.ownPanel}`}>
        <div className={styles.panelHeading}><span className={styles.headingIcon}><PenLine size={19} aria-hidden /></span><h3>Start with your own idea</h3></div>
        <p className={styles.description}>Bring the spark. Turn a thought into the next finished draft.</p>
        <div className={styles.ownActions}>
          <input className={styles.seedInput} value={own} onChange={(event) => setOwn(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onAddOwn(); }} placeholder={ownPlaceholder} maxLength={IDEAS_MANUAL_MAX} aria-label="Your idea" />
          <button className="btn btn-sm" onClick={onAddOwn} disabled={ownBusy || !own.trim()}>{ownBusy ? "Working…" : ownActionLabel}</button>
        </div>
      </section>
    </div>
  );
}

export function IdeasFilterBar({ q, setQ, cat, setCat, cats }: {
  q: string; setQ: (value: string) => void; cat: string; setCat: (value: string) => void; cats: string[];
}) {
  return (
    <div className={styles.filterBar}>
      <div className={styles.search}><Search size={15} aria-hidden /><input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Filter ideas…" aria-label="Filter ideas" /></div>
      {cats.length > 1 && <div className={styles.categories}>{cats.map((category) => <button key={category} onClick={() => setCat(category)} aria-pressed={cat === category} className={cat === category ? styles.categoryActive : undefined}>{category}</button>)}</div>}
    </div>
  );
}

export function IdeasGrid({ children }: { children: React.ReactNode }) {
  return <div className={styles.ideaGrid}>{children}</div>;
}

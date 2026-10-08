"use client";

import styles from "./segmented-control.module.css";

export function SegmentedControl({ value, onChange, options, label }: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<readonly [value: string, label: string]>;
  label: string;
}) {
  return <div className={styles.control} role="group" aria-label={label}>{options.map(([option, title]) => <button key={option} type="button" aria-pressed={option === value} className={option === value ? styles.active : undefined} onClick={() => onChange(option)}>{title}</button>)}</div>;
}

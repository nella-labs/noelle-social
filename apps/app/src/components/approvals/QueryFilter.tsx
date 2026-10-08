"use client";

import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import styles from "./query-filter.module.css";

/**
 * Generic URL-param `<select>` filter for the approvals inbox.
 *
 * Uses `router.replace` to preserve other query params without a scroll jump.
 * Shared by status, source, score, and the other inbox filters.
 *
 * `defaultValue` is the option that maps to "no param in the URL" — selecting
 * it deletes the key so the query falls back to the server-side default
 * (`status='pending'`, `source='real'`).
 */

export interface QueryFilterOption {
  value: string;
  label: string;
}

interface Props {
  basePath: string;
  /** URL query key, e.g. "status" or "source". */
  param: string;
  /** Short label shown above the select. */
  label: string;
  options: QueryFilterOption[];
  /** Value treated as the default (omitted from the URL). Defaults to "". */
  defaultValue?: string;
}

export function QueryFilter({
  basePath,
  param,
  label,
  options,
  defaultValue = "",
}: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const current = params.get(param) ?? defaultValue;
  const id = React.useId();

  const handleChange = React.useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = new URLSearchParams(params.toString());
      if (e.target.value && e.target.value !== defaultValue) {
        next.set(param, e.target.value);
      } else {
        next.delete(param);
      }
      const qs = next.toString();
      router.replace(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
    },
    [router, params, basePath, param, defaultValue],
  );

  return (
    <div className={styles.field} data-active={current !== defaultValue || undefined}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <select
        id={id}
        name={param}
        value={current}
        onChange={handleChange}
        className={styles.select}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

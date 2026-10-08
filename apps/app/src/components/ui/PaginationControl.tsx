"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import styles from "./pagination-control.module.css";

export function PaginationControl({ page, pageSize, totalRows, onPageChange, label = "Pagination" }: {
  page: number;
  pageSize: number;
  totalRows: number;
  onPageChange: (page: number) => void;
  label?: string;
}) {
  if (totalRows === 0) return null;
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
  const firstRow = (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, totalRows);
  return (
    <nav className={styles.control} aria-label={label}>
      <span className={styles.range}>{firstRow}–{lastRow} of {totalRows}</span>
      <div className={styles.buttons}>
        <button type="button" className="btn btn-sm" aria-label="Previous page" onClick={() => onPageChange(page - 1)} disabled={page <= 1}><ChevronLeft size={14} aria-hidden />Previous</button>
        <span className={styles.page} role="status" aria-live="polite">Page {page} of {pageCount}</span>
        <button type="button" className="btn btn-sm" aria-label="Next page" onClick={() => onPageChange(page + 1)} disabled={page >= pageCount}>Next<ChevronRight size={14} aria-hidden /></button>
      </div>
    </nav>
  );
}

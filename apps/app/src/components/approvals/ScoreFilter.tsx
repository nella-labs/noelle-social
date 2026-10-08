"use client";

import { QueryFilter } from "./QueryFilter";

/**
 * Min-score filter for the approvals inbox.
 *
 * Drives `?minScore=` on the approvals route, which `page.tsx` threads into
 * `listPendingApprovalsForOrg`. We keep this client-side (rather than a
 * plain `<form method="GET">`) so the URL update preserves the
 * already-present `?stream=` param via `useSearchParams`, and so the change
 * commits with `router.replace` — no full reload, no scroll jump.
 *
 * Thresholds match the classifier's quality bands. NULL classifier scores
 * (pre-mirror or skipped) always pass through the query — see the helper.
 */

interface Props {
  basePath: string;
}

const THRESHOLDS: { value: string; label: string }[] = [
  { value: "", label: "Any score" },
  { value: "0.5", label: "≥ 50 · ok" },
  { value: "0.6", label: "≥ 60 · good" },
  { value: "0.75", label: "≥ 75 · high" },
  { value: "0.9", label: "≥ 90 · elite" },
];

export function ScoreFilter({ basePath }: Props) {
  return (
    <QueryFilter basePath={basePath} param="minScore" label="Min score" options={THRESHOLDS} />
  );
}

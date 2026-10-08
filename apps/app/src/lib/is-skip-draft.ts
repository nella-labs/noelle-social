/**
 * Detect whether a draft payload is functionally a "SKIP" — i.e. the
 * drafter judged the lead off-topic and embedded the rejection text into
 * the angle bodies instead of returning the typed `{ skip: "…" }` shape.
 *
 * Historical context: pre-2026-05-26, Bedrock Sonnet 4.6 occasionally
 * returned `{ drafts: [{ angle: "empathetic", body: "SKIP: no nella
 * connection ..." }, …] }`. That shape passed the strict zod enum and
 * created real pending approval rows with skip text inside. Those rows
 * are still in `noelle.approvals` and would otherwise clutter the inbox.
 *
 * The drafter now normalises that output into `{ skip: … }` (see
 * `apps/x-intern/src/workers/drafter-tick.ts:normalizeSkipShape`) so new
 * runs don't repeat the bug — this helper is purely a defensive filter
 * on the read path so stale rows don't appear AND any future regression
 * doesn't bleed into the UI.
 *
 * Marker list mirrors `PROSE_SKIP_MARKERS` in drafter-tick.ts. If new
 * markers are added there, mirror them here.
 */

import { bodyForAngle, bodyForSelectedAngle, type DraftPayloadView } from "@/lib/payload-shapes";
import { AngleSchema } from "@noelle/contracts";

export const SKIP_MARKERS = [
  "no nella connection",
  "no overlap with nella",
  "no nella fit",
  "not a nella fit",
  "recommending skip",
  "recommend skipping",
  "skip this lead",
];

function bodyIsSkip(body: string | null | undefined): boolean {
  if (!body) return false;
  const trimmed = body.trim();
  if (!trimmed) return false;
  if (/^SKIP:/i.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  return SKIP_MARKERS.some((m) => lower.includes(m));
}

/**
 * Returns true when every non-empty angle body in the draft payload
 * matches a skip marker. Drafts with at least one real-looking body are
 * treated as legitimate even if one angle was a skip — the reviewer can
 * still pick the working angle.
 */
export function isAllSkipDraft(dp: DraftPayloadView): boolean {
  const bodies = [bodyForSelectedAngle(dp), ...AngleSchema.options.map((angle) => bodyForAngle(dp, angle))]
    .filter((body): body is string => body !== undefined);
  if (bodies.length === 0) return false; // nothing to evaluate — let it through
  return bodies.every(bodyIsSkip);
}

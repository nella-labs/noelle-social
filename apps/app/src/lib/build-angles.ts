/**
 * Pull the three drafter angles out of a `drafts.payload` JSONB.
 *
 * Tolerates both shapes documented in payload-shapes.ts:
 *   - bundled: `payload.angles.<empathetic|technical|contrarian>.body`
 *   - single:  `payload.angle` (one of the three) + `payload.body`
 *
 * Returned angles are always ordered empathetic → technical → contrarian
 * so the UI is stable across drafts. Missing angles are simply omitted
 * — the inbox never invents text the drafter didn't produce.
 */
import type { AngleOption } from "@/components/approvals/DraftReviewPanel";
import { bodyForAngle, type DraftPayloadView } from "@/lib/payload-shapes";
import { AngleSchema } from "@noelle/contracts";

export const ANGLE_ORDER = AngleSchema.options;
export type AngleKey = (typeof ANGLE_ORDER)[number];

export const ANGLE_LABEL: Record<AngleKey, string> = {
  empathetic: "Empathetic",
  technical: "Technical",
  contrarian: "Contrarian",
};

/**
 * Build the angle options for a whole lead from its individual reply drafts.
 *
 * Each reply angle is a SEPARATE draft+approval (the drafter writes one row per
 * variant), so we flatten across all of a lead's reply drafts and stamp each
 * resulting angle with its own `approvalId` — that's what lets the detail page
 * send/skip the *selected* angle's approval. Ordered empathetic → technical →
 * contrarian; the first draft to supply a given angle wins (dedupe).
 */
export function buildAnglesFromDrafts(
  drafts: ReadonlyArray<{ approvalId: string; payload: DraftPayloadView }>,
): AngleOption[] {
  const byAngle = new Map<string, AngleOption>();
  for (const { approvalId, payload } of drafts) {
    for (const a of buildAngles(payload)) {
      if (!byAngle.has(a.id)) byAngle.set(a.id, { ...a, approvalId });
    }
  }
  return ANGLE_ORDER.map((k) => byAngle.get(k)).filter(
    (a): a is AngleOption => a != null,
  );
}

export function buildAngles(dp: DraftPayloadView): AngleOption[] {
  // A DM is a single message with no angle — it is rendered by the
  // DM-specific surface (DMReviewPanel / the speedrun DM card), not the
  // angle picker. Returning [] keeps angle-only callers honest.
  if (dp.kind === "dm") return [];
  const out: AngleOption[] = [];
  for (const key of ANGLE_ORDER) {
    const body = bodyForAngle(dp, key);
    if (body !== undefined) {
      out.push({
        id: key,
        kind: ANGLE_LABEL[key],
        text: body,
        quality: dp.score ?? null,
      });
    }
  }
  return out;
}

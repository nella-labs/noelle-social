// The edits-ledger decision, factored out so it's unit-testable without the
// full route DB harness. An operator's Mark-ready edit is worth recording as a
// voice correction only when they actually changed the drafter's body —
// ignoring surrounding whitespace, and never for a null/absent edit.
export function shouldRecordContentEdit(
  before: string,
  editedBody: string | null | undefined,
): editedBody is string {
  if (editedBody == null) return false;
  return editedBody.trim() !== before.trim();
}

import type { Sql } from "postgres";
import type { ContentPostEdit } from "@noelle/runtime";

/** Voice corrections use the fresh body captured by the committed mutation. */
export async function recordContentEdit(sql: Sql, edit: ContentPostEdit): Promise<void> {
  if (!shouldRecordContentEdit(edit.before, edit.after)) return;
  try {
    await sql`insert into noelle.content_edits(org_id,draft_id,platform,before_body,after_body)
      values (${edit.orgId},${edit.draftId},${edit.platform},${edit.before},${edit.after})`;
  } catch {
    console.error("[posts] content_edits ledger insert failed (non-fatal)");
  }
}

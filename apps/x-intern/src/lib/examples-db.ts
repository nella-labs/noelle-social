import type { Sql } from "postgres";

/**
 * Sent replies at or under this length are preferred as few-shot exemplars.
 * Sits just above the drafter's 120-char target so a good reply at the top of
 * the band still qualifies, and below the 150 hard ceiling.
 */
const SHORT_EXAMPLE_CHARS = 140;

/**
 * Recent reply bodies the operator actually SENT for this instance — the
 * self-improvement signal. When the operator edited a draft before sending,
 * `edited_body` is the human-corrected text (the strongest exemplar), so we
 * prefer it over the original `body`. Newest first.
 *
 * Fed into the drafter prompt as "replies that worked" few-shot exemplars so
 * the model drifts toward what the operator approves and away from what they
 * rewrite. Returns [] on any error (fail-open — examples are a nice-to-have).
 *
 * With `preferShort`, ordering prefers SHORT sends after the edited-first
 * priority. Selecting purely by recency created a length ratchet: a long draft
 * gets sent, becomes an exemplar, the next drafts imitate its length, and so on
 * (measured on X: June avg 160 chars -> July 180 -> pending queue 209, against a
 * target band of 40-120). The `<= SHORT_EXAMPLE_CHARS` term is a soft
 * preference, not a filter, so a thin result set still fills from longer sends.
 *
 * `preferShort` is OFF by default because this function has a second caller: the
 * reply-diversity gate uses it as the near-duplicate corpus, and that one wants
 * strict recency ("did I already say this lately?"). Short-biasing the dedup set
 * would let a recent long reply drop out of it and be repeated.
 */
export async function getRecentSentExamples(
  sql: Sql,
  instanceId: string,
  limit: number,
  opts: { preferShort?: boolean } = {},
): Promise<string[]> {
  if (limit <= 0) return [];
  try {
    // Soft length preference, injected as a whole ORDER BY term so the default
    // (diversity-gate) path keeps its exact previous SQL.
    const shortFirst = opts.preferShort
      ? sql`(length(coalesce(nullif(d.payload->>'edited_body', ''), d.payload->>'body')) <= ${SHORT_EXAMPLE_CHARS}) desc,`
      : sql``;
    const rows = await sql<{ body: string | null; edited: boolean }[]>`
      select
        coalesce(nullif(d.payload->>'edited_body', ''), d.payload->>'body') as body,
        (d.payload->>'edited') is not null and d.payload->>'edited' = 'true' as edited
      from noelle.approvals a
      join noelle.drafts d on d.id = a.draft_id
      where a.agent_instance_id = ${instanceId}
        and a.status = 'sent'
        and d.payload->>'kind' = 'reply'
      order by
        (d.payload->>'edited' = 'true') desc,
        ${shortFirst}
        a.decided_at desc nulls last
      limit ${limit}
    `;
    return rows
      .map((r) => r.body?.trim())
      .filter((b): b is string => Boolean(b));
  } catch {
    return [];
  }
}

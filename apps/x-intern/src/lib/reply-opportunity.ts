import { readXSourceId } from "@noelle/x-client";
import { trimMemorySql } from "@noelle/runtime";
import type { Fragment, Sql, TransactionSql } from "postgres";

/** Queue capacity and the preferred fresh-trend portion of active replies. */
export const OBSERVED_REPLY_ACTIVE_CAP = 12;
export const OBSERVED_TRENDING_TARGET = 7;

/** Transparent queue heuristics, separate from the classifier's evidence. */
export interface ReplyOpportunityCandidate {
  id: string;
  external_id: string;
  author_handle: string;
  classifier_score: unknown;
  payload: Record<string, unknown>;
  created_at?: string | Date;
}

export interface ReplyOpportunity {
  version: 1;
  quality: number | null;
  age_hours: number | null;
  freshness: number;
  momentum: number | null;
  recent_author_replies: number;
  author_penalty: number;
  trending: boolean;
  score: number;
}

export const replyAuthorKey = (handle: unknown): string =>
  typeof handle === "string" ? handle.trim().replace(/^@/, "").toLowerCase() : "";
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = (value: unknown): number | null => {
  if (!(typeof value === "string" || value instanceof Date)) return null;
  if (typeof value === "string") {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const day = Date.parse(value.slice(0, 10) + "T00:00:00Z");
    if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};
const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** Only saved numeric thread identifiers participate in conversation dedup. */
export function replyConversationId(payload: Record<string, unknown>): string | null {
  const conversation = payload.conversation;
  const root = conversation && typeof conversation === "object"
    ? (conversation as Record<string, unknown>).root_post_id : undefined;
  return readXSourceId(payload.conversation_id, payload.conversationId, payload.root_post_id, root);
}

/** Match saved JSON identities after the same number decoding used by readXSourceId. */
export function replyConversationIdSql(sql: Sql | TransactionSql, payload: Fragment): Fragment {
  const candidate = (value: Fragment) => {
    const text = trimMemorySql(sql, sql`${value} #>> '{}'`);
    // Only this exact range can round into a safe, nonzero JavaScript integer.
    // The nested CASE prevents overflow/underflow before converting to binary64.
    const decoded = sql`case when jsonb_typeof(${value}) = 'number' then
      case when (${value} #>> '{}')::numeric between 0.5 and 9007199254740992
        then (${value} #>> '{}')::double precision end end`;
    return sql`case when jsonb_typeof(${value}) = 'string' then
      case when length(${text}) between 1 and 25 then
        case when ${text} ~ '^[0-9]+$' and ${text} ~ '[1-9]' then ${text} end end
      else (select case when id >= 1 and id <= 9007199254740991::double precision
          and id = trunc(id) then id::bigint::text end
        from (select ${decoded} as id) decoded_id) end`;
  };
  return sql`coalesce(${candidate(sql`${payload}->'conversation_id'`)},
    ${candidate(sql`${payload}->'conversationId'`)}, ${candidate(sql`${payload}->'root_post_id'`)},
    ${candidate(sql`${payload}->'conversation'->'root_post_id'`)})`;
}

export function scoreReplyOpportunity(
  candidate: ReplyOpportunityCandidate, now: Date, recentAuthorReplies: number,
): ReplyOpportunity {
  const qualityRaw = typeof candidate.classifier_score === "string"
    && candidate.classifier_score.trim() !== "" ? Number(candidate.classifier_score) : candidate.classifier_score;
  const quality = typeof qualityRaw === "number" && Number.isFinite(qualityRaw)
    ? Math.max(0, Math.min(1, qualityRaw)) : null;
  const postedAt = timestamp(candidate.payload.posted_at);
  const ageHours = postedAt != null && postedAt <= now.getTime() + 5 * 60_000
    ? Math.max(0, (now.getTime() - postedAt) / 3_600_000) : null;
  const likes = count(candidate.payload.likeCount);
  const replies = count(candidate.payload.replyCount);
  // A snapshot per elapsed hour is an opportunity proxy, not measured velocity.
  const momentum = ageHours != null && (likes != null || replies != null)
    ? ((likes ?? 0) + 2 * (replies ?? 0)) / Math.max(1, ageHours) : null;
  const freshness = ageHours == null ? 0.5 : 1 / (1 + ageHours / 24);
  const recent = count(recentAuthorReplies) ?? 0;
  const authorPenalty = Math.min(0.15, recent * 0.05);
  const trending = ageHours != null && ageHours <= 24 &&
    ((likes ?? 0) >= 50 || (replies ?? 0) >= 12 ||
      ((likes ?? 0) + 2 * (replies ?? 0) >= 10 && (momentum ?? 0) >= 5));
  // Qualification dominates; freshness, bounded momentum and author variety
  // only order posts that have already passed the separate qualification gate.
  const score = (quality ?? 0) * (0.8 + 0.2 * freshness)
    + 0.04 * freshness + (trending ? 0.02 * Math.min(1, Math.log1p(momentum ?? 0) / Math.log(101)) : 0)
    - authorPenalty;
  return { version: 1, quality, age_hours: ageHours == null ? null : round(ageHours),
    freshness: round(freshness), momentum: momentum == null ? null : round(momentum),
    recent_author_replies: recent, author_penalty: authorPenalty, trending, score: round(score) };
}

export function selectReplyOpportunities<T extends ReplyOpportunityCandidate>(
  candidates: T[], args: {
    now: Date; slots: number; trendNeed: number;
    recentAuthorReplies?: Map<string, number>;
    occupiedAuthors?: Set<string>;
    occupiedConversations?: Set<string>;
    blockedTargets?: Set<string>;
    blockedConversations?: Set<string>;
  },
): Array<T & { opportunity: ReplyOpportunity }> {
  const newest = new Map<string, T>();
  const posted = (candidate: T) => {
    const ms = timestamp(candidate.payload.posted_at);
    return ms != null && ms <= args.now.getTime() + 5 * 60_000
      ? ms : timestamp(candidate.created_at) ?? 0;
  };
  for (const candidate of candidates) {
    const author = replyAuthorKey(candidate.author_handle) || candidate.id;
    const conversation = replyConversationId(candidate.payload);
    if (args.occupiedAuthors?.has(author) || args.blockedTargets?.has(candidate.external_id)
      || (conversation && (args.blockedTargets?.has(conversation)
        || args.blockedConversations?.has(conversation) || args.occupiedConversations?.has(conversation)))) continue;
    const prior = newest.get(author);
    if (!prior || posted(candidate) > posted(prior)
      || (posted(candidate) === posted(prior) && candidate.id.localeCompare(prior.id) < 0)) newest.set(author, candidate);
  }
  const ranked = [...newest.values()].map((candidate) => ({ ...candidate,
    opportunity: scoreReplyOpportunity(candidate, args.now,
      args.recentAuthorReplies?.get(replyAuthorKey(candidate.author_handle)) ?? 0),
  })).sort((a, b) => Number(b.opportunity.quality != null) - Number(a.opportunity.quality != null)
    || b.opportunity.score - a.opportunity.score || posted(b) - posted(a) || a.id.localeCompare(b.id));
  const conversations = new Set(args.occupiedConversations);
  const diverse = ranked.filter((candidate) => {
    const conversation = replyConversationId(candidate.payload);
    if (conversation && conversations.has(conversation)) return false;
    if (conversation) conversations.add(conversation);
    return true;
  });
  const trend = diverse.filter((candidate) => candidate.opportunity.trending);
  const normal = diverse.filter((candidate) => !candidate.opportunity.trending);
  const reserve = Math.max(0, Math.min(args.slots, args.trendNeed));
  const order = [...trend.slice(0, reserve), ...normal, ...trend.slice(reserve)];
  return order.slice(0, Math.max(0, args.slots));
}

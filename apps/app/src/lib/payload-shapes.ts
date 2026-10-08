/**
 * Typed accessors for the JSONB `payload` columns on noelle.leads
 * and noelle.drafts.
 *
 * Rows are written verbatim by the agents-VM drafter — snake_case columns
 * straight off the producer side. @noelle/types reflects the column shape as
 * `Json` (since Postgres can't statically type JSONB), so we narrow here in
 * one place rather than casting inline at every read site.
 *
 * Columns NOT yet present in the 0.0.1 payload (per the producer's SELECT lists):
 *   leads:   tier, quality_score, originalPostUrl, classifier_*
 *   drafts:  quality_score, source_engine, model
 *
 * Anything missing is `undefined` here — the UI shows neutral fallback states.
 */

import type {
  NoelleDraft,
  NoelleLead,
} from "@/lib/db-types";
import { AngleSchema, type Angle, type OutboundIn } from "@noelle/contracts";
import { buildXPostUrl } from "./x-post-url";

export interface LeadPayloadView {
  id?: string;
  post_id?: string;
  author_handle?: string;
  author_id?: string;
  author_followers?: number | null;
  post_text?: string;
  posted_at?: string;
  status?: string;
  matched_trigger_id?: string | null;
  created_at?: string;
  /** Computed: x.com URL derived from author_handle + post_id. */
  originalPostUrl?: string;
  /** Not yet mirrored — included for future classifier sync. */
  tier?: "T1" | "T2" | "T3" | null;
  velocity_score?: number;
  // --- Producer (drafter/outbound) keys. The outbound route overwrites the
  // lead payload with the OutboundIn shape, so on any lead that has a draft
  // these are the real fields; leadPayload() aliases them onto the canonical
  // names above so call sites stay clean. ---
  original_post_text?: string;
  original_post_id?: string;
  original_post_url?: string;
  matched_trigger?: string | null;
  /** Voice-anchor snippets the drafter used to ground this lead's drafts. */
  anchors?: Array<{ snippet: string; score: number }>;
}

export interface DraftPayloadView {
  id?: string;
  lead_id?: string;
  /** null for a `dm` draft — DMs are a single message, not a per-angle variant. */
  angle?: "empathetic" | "technical" | "contrarian" | null;
  kind?: "reply" | "dm" | "repost";
  body?: string;
  edited_body?: string | null;
  char_count?: number | null;
  selected?: boolean;
  created_at?: string;
  sent_at?: string | null;
  /**
   * URL of the live tweet, written by the send worker after
   * `XClient.createTweet` succeeds. Surfaced on the detail page as a
   * "Posted to X" deeplink. Present iff the draft was actually posted
   * (i.e. `drafts.sent_external_id IS NOT NULL`).
   */
  sent_url?: string | null;
  /** Either a flat angle row or a 3-angle bundle. */
  angles?: {
    empathetic?: { id?: string; body?: string };
    technical?: { id?: string; body?: string };
    contrarian?: { id?: string; body?: string };
  };
  /** Not mirrored in 0.0.1 — quality gate runs upstream of the drafter only. */
  score?: number | null;
  verifier_meta?: unknown;
  human_review_required?: boolean;
  human_send_approved?: boolean;
  replyTarget?: OutboundIn["drafts"][number]["replyTarget"];
  /**
   * Account-Feeder style-source blend: the human accounts whose FORM shaped this
   * draft, each with its share (0..1) of the chosen style exemplars. Written by
   * the api-vm outbound route when style injection ran. Absent/null ⇒ the reply
   * used the operator's base voice (Mars) only.
   */
  style_source?: { blend: Array<{ handle: string; weight: number }> } | null;
}

/** Narrow a row's jsonb `payload` to the LeadPayloadView shape. */
export function leadPayload(lead: NoelleLead | null | undefined): LeadPayloadView {
  if (!lead?.payload) return {};
  const p = lead.payload as unknown as LeadPayloadView;
  // Alias the producer's keys onto the canonical names. The outbound route
  // overwrites the lead payload with the drafter's OutboundIn shape
  // (original_post_*), so for any lead that produced a draft these are the
  // fields that actually hold the data. Without this, post text + the
  // source-tweet link silently read undefined and the UI shows
  // "(post text not synced yet)".
  p.post_text ??= p.original_post_text;
  p.post_id ??= p.original_post_id;
  p.originalPostUrl ??= p.original_post_url;
  p.matched_trigger_id ??= p.matched_trigger ?? null;
  // Derive the x.com URL if still missing. Prefer the producer's post_id, but
  // fall back to the lead's external_id — the real tweet id, which (unlike
  // post_id) is reliably synced. buildXPostUrl returns null for synthetic ids
  // and uses /i when the handle is unknown.
  if (!p.originalPostUrl) {
    p.originalPostUrl =
      buildXPostUrl({
        handle: p.author_handle,
        tweetId: p.post_id ?? lead.external_id,
      }) ?? undefined;
  }
  return p;
}

export function draftPayload(draft: NoelleDraft | null | undefined): DraftPayloadView {
  if (!draft?.payload) return {};
  return draft.payload as unknown as DraftPayloadView;
}

/**
 * The LinkedIn lead payload shape.
 *
 * Two producers write this jsonb at different lifecycle stages:
 *   - discovery (apps/linkedin-intern discovery-tick): `text`, `url`, `postedAt`,
 *     `authorName`, `authorHeadline`, `authorPublicId`, `reactions`, `comments`.
 *   - outbound (api-vm) OVERWRITES the row once the drafter runs, replacing the
 *     payload with the OutboundIn shape: `original_post_text`, `original_post_url`,
 *     `author_handle` (= public id), `author_id` (= fsd profile id), `anchors`.
 *     The author NAME/HEADLINE are NOT in OutboundIn, so on any lead that has a
 *     draft they live only in noelle.linkedin_watchlist_people (joined by the
 *     query that builds LinkedInApprovalView), not here.
 *
 * `linkedinLeadPayload()` normalises both stages onto canonical names so the
 * UI reads one shape regardless of which producer last wrote the row.
 */
export interface LinkedInLeadPayloadView {
  /** The post body. `text` (discovery) or `original_post_text` (post-drafter). */
  postText?: string;
  /** Permalink to the LinkedIn post. `url` or `original_post_url`. */
  postUrl?: string;
  /** Vanity slug. `authorPublicId` (discovery) or `author_handle` (post-drafter). */
  authorPublicId?: string;
  /** Display name — only present pre-drafter (discovery payload). */
  authorName?: string;
  /** Headline — only present pre-drafter (discovery payload). */
  authorHeadline?: string;
  postedAt?: string;
  /** Lead category, e.g. standalone Friendly DMs. */
  postKind?: string | null;
  /** Voice-anchor snippets the drafter grounded this lead's drafts on. */
  anchors?: Array<{ snippet: string; score: number }>;
}

interface LinkedInRawPayload {
  text?: string;
  original_post_text?: string;
  url?: string;
  original_post_url?: string;
  authorPublicId?: string;
  author_handle?: string;
  authorName?: string;
  authorHeadline?: string;
  postedAt?: string;
  posted_at?: string;
  post_kind?: string | null;
  anchors?: Array<{ snippet: string; score: number }>;
}

/** Narrow + normalise a LinkedIn lead's jsonb `payload`. */
export function linkedinLeadPayload(
  lead: NoelleLead | null | undefined,
): LinkedInLeadPayloadView {
  if (!lead?.payload) return {};
  const p = lead.payload as unknown as LinkedInRawPayload;
  return {
    postText: p.text ?? p.original_post_text,
    postUrl: p.url ?? p.original_post_url,
    authorPublicId: p.authorPublicId ?? p.author_handle,
    authorName: p.authorName,
    authorHeadline: p.authorHeadline,
    postedAt: p.postedAt ?? p.posted_at,
    postKind: p.post_kind ?? null,
    anchors: p.anchors,
  };
}

/** Normalise discovery and outbound Reddit source fields without X links. */
export function redditLeadFields(raw: unknown): {
  subreddit: string | null;
  threadTitle: string | null;
  postText: string | null;
  postUrl: string | null;
  postedAt: string | null;
  authorHandle: string | null;
} {
  const p = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const str = (v: unknown): string | null => typeof v === "string" && v.trim() ? v : null;
  return {
    subreddit: str(p.subreddit) ?? str(p.subreddit_name),
    threadTitle: str(p.title) ?? str(p.post_title),
    postText: str(p.original_post_text) ?? str(p.text) ?? str(p.post_text) ?? str(p.selftext) ?? str(p.body),
    postUrl: str(p.original_post_url) ?? str(p.url) ?? str(p.post_url) ?? str(p.permalink),
    postedAt: str(p.posted_at) ?? str(p.postedAt) ?? str(p.created_at),
    authorHandle: str(p.author_handle) ?? str(p.author),
  };
}

/**
 * Live X permalink to Vega's SENT reply — the post with the reply in it.
 *
 * Prefers the authoritative `sent_url` the send worker wrote into the draft
 * payload; otherwise synthesises one from the reply's tweet id
 * (`drafts.sent_external_id`). Returns null for an unsent draft or the
 * `manual:` sentinel (a hand-posted reply has no captured URL). Single source
 * of truth so every surface (sent panel, activity feed, inbox, detail) links
 * the same way.
 */
export function sentReplyUrl(opts: {
  sentUrl?: string | null;
  sentExternalId?: string | null;
  authorHandle?: string | null;
}): string | null {
  if (opts.sentUrl) return opts.sentUrl;
  if (!opts.sentExternalId || opts.sentExternalId.startsWith("manual:")) return null;
  return buildXPostUrl({ handle: opts.authorHandle, tweetId: opts.sentExternalId });
}

/** A legacy bundle edit needs one recorded or uniquely available angle. */
export function selectedDraftAngle(payload: DraftPayloadView): Angle | null {
  const selected = AngleSchema.safeParse(payload.angle);
  if (selected.success) return selected.data;
  const available = AngleSchema.options.filter((angle) => textBody(payload.angles?.[angle]?.body) !== undefined);
  if (Object.hasOwn(payload, "edited_body") && available.length !== 1) return null;
  return available[0] ?? null;
}

function textBody(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Resolve one variant; an explicit edit cannot revive its original body. */
export function bodyForAngle(
  payload: DraftPayloadView,
  angle: "empathetic" | "technical" | "contrarian",
): string | undefined {
  if (Object.hasOwn(payload, "edited_body")) {
    const selected = selectedDraftAngle(payload);
    if (selected === null) return undefined;
    if (selected === angle) return textBody(payload.edited_body);
  }
  const bundled = textBody(payload.angles?.[angle]?.body);
  if (bundled !== undefined) return bundled;
  if (payload.angle === angle) return textBody(payload.body);
  return undefined;
}

/** Quote the authoritative body without inventing an ambiguous edit's angle. */
export function bodyForSelectedAngle(payload: DraftPayloadView): string | undefined {
  if (Object.hasOwn(payload, "edited_body")) return textBody(payload.edited_body);
  const selected = selectedDraftAngle(payload);
  return (selected ? bodyForAngle(payload, selected) : undefined) ?? textBody(payload.body);
}

/** Resolve the draft id to send for an angle. */
export function draftIdForAngle(
  payload: DraftPayloadView,
  angle: "empathetic" | "technical" | "contrarian",
  fallback: string,
): string {
  return payload.angles?.[angle]?.id ?? payload.id ?? fallback;
}

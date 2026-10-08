// LIVE-TUNE: linkedin.com/notifications scraping for the notifications actor
// ("Auto notifications"). Pure functions over a DOM root, so every rule is
// unit-tested against fixtures instead of a live tab.
//
// LinkedIn's notification markup churns constantly (see the class-agnostic
// fallbacks in selectors.ts), so nothing here depends on a single class name:
// a card is "an element that contains exactly one profile link and one post
// link", and what kind of notification it is comes from its TEXT.

/** One harvested notification card. */
export interface HarvestedNotification {
  /**
   * Stable id for this notification: the real comment urn when the card's link
   * exposes one (it does, via its `commentUrn` param), else the post urn plus
   * the commenter. Lands on noelle.leads.external_id, whose UNIQUE constraint
   * is the idempotency key.
   */
  external_id: string;
  /** Their profile public id (the /in/{publicId} segment). */
  public_id: string;
  /** Their display name, as the card renders it. */
  name: string;
  /** The comment snippet the card quotes — what we are answering. */
  text: string;
  /** The post permalink the actuator opens to comment under. */
  url: string;
  /** The post's canonical urn (activity / ugcPost / share). */
  activity_urn: string | null;
  /** The original post the comment sits on, when the card quotes it. "" if not. */
  post_context: string;
  /**
   * How old the card says it is, in minutes, parsed from its relative time
   * ("6h", "1d"). null when the card renders no readable age — which the
   * recency gate treats as "cannot prove it is recent", i.e. skip.
   */
  age_minutes: number | null;
};

/**
 * Notification headlines that mean "somebody replied to something of mine".
 * Only replies enter this lane. A reaction, a follow, a
 * job alert, a "trending in your network", or a bare mention is not a reply and
 * must never enter the conversation lane.
 */
const REPLY_HEADLINES = [
  /\bcommented on your\b/i,
  /\breplied to your\b/i,
  /\bmentioned you in a comment\b/i, // a comment aimed at us IS a reply to us
];

/** Headlines that look conversational but are not replies to us. */
const NOT_A_REPLY = [
  /\blikes? your\b/i,
  /\breacted to\b/i,
  /\bcelebrates?\b/i,
  /\bfollows? you\b/i,
  /\bviewed your\b/i,
  /\bcommented on\b(?!\s+your)/i, // "commented on a post you follow" — not ours
];

export function isReplyHeadline(text: string): boolean {
  if (NOT_A_REPLY.some((re) => re.test(text))) return false;
  return REPLY_HEADLINES.some((re) => re.test(text));
}

/** The /in/{publicId} segment of a profile href, or null. */
export function publicIdFrom(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = /\/in\/([^/?#]+)/.exec(href);
  if (!m) return null;
  // decodeURIComponent THROWS a URIError on a malformed escape ("%E0%A4%A").
  // Unguarded, one such href would blow up the whole harvest — the content
  // script's handler throws, the sweep's send() rejects, and every OTHER
  // notification on the page is lost with it. Fall back to the raw segment.
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/**
 * Percent-decode a notification href, tolerating a malformed escape.
 *
 * LIVE-TUNE, verified against a real captured card: notification links arrive
 * ENCODED — `/feed/update/urn%3Ali%3AugcPost%3A748...?commentUrn=urn%3Ali%3A...`
 * — so every urn pattern below has to be matched on the decoded string.
 */
function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/**
 * The `highlightedUpdateType` param — LinkedIn's OWN machine-readable name for
 * what this notification is. Captured values include REPLIED_TO_YOUR_COMMENT,
 * REACTED_TO_YOUR_COMMENT, COMMENT_VIEWS, MENTIONED_YOU_IN_THIS,
 * REACTED_TO_COMMENT_MENTIONING_YOU, TOPIC_TRENDING_CONVERSATION_IN_YOUR_NETWORK.
 * Far more robust than matching the headline's prose, so it is the primary
 * signal; the headline text stays as the fallback when the param is absent.
 */
export function notificationTypeFrom(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /highlightedUpdateType=([A-Z_]+)/.exec(decodeHref(url));
  return m ? m[1]! : null;
}

/** The notification types that mean "somebody wrote something addressed to me". */
const REPLY_TYPES = new Set([
  "REPLIED_TO_YOUR_COMMENT",
  // A comment that @-mentions us is written AT us — same thing as a reply for
  // our purposes. (REACTED_TO_COMMENT_MENTIONING_YOU is a reaction, not a reply,
  // and is deliberately absent.)
  "MENTIONED_YOU_IN_THIS",
  "COMMENTED_ON_YOUR_POST",
  "REPLIED_TO_YOUR_POST",
]);

export function isReplyType(type: string | null | undefined): boolean {
  return type != null && REPLY_TYPES.has(type);
}

/**
 * The THREAD ROOT post urn, or null.
 *
 * LIVE-TUNE, from real captured hrefs. A reply notification links to
 *   /feed/?highlightedUpdateUrn=urn:li:activity:<notificationActivity>
 *          &commentUrn=urn:li:comment:(ugcPost:<POST>,<ourComment>)
 *          &replyUrn=urn:li:comment:(ugcPost:<POST>,<theirReply>)
 * so `highlightedUpdateUrn` is the notification's OWN activity, NOT the post —
 * reading it would give a different "root" for every notification on one thread
 * and defeat the turn cap. The real root is the entity inside the comment urn
 * tuple, which is identical across every notification about that post.
 */
export function activityUrnFrom(url: string | null | undefined): string | null {
  if (!url) return null;
  const s = decodeHref(url);
  const inComment = /urn:li:comment:\((activity|ugcPost|share):(\d+)/.exec(s);
  if (inComment) return `urn:li:${inComment[1]}:${inComment[2]}`;
  const path = /\/feed\/update\/urn:li:(activity|ugcPost|share):(\d+)/.exec(s);
  if (path) return `urn:li:${path[1]}:${path[2]}`;
  const any = /urn:li:(activity|ugcPost|share):(\d+)/.exec(s);
  if (any) return `urn:li:${any[1]}:${any[2]}`;
  const slug = /activity[-:](\d+)/.exec(s);
  return slug ? `urn:li:activity:${slug[1]}` : null;
}

/**
 * THEIR comment id — the message we are answering.
 *
 * LIVE-TUNE, and a real collision bug: a reply notification carries BOTH
 * `commentUrn` (OUR comment, the one they replied to) and `replyUrn` (THEIR
 * reply). Taking the first `urn:li:comment:` in the query string returns OURS,
 * so every different person replying to the same comment of ours would collapse
 * onto ONE external_id — the first ingested, the rest reported `duplicate` and
 * never answered. Prefer replyUrn; fall back to commentUrn for the card shapes
 * that carry only one.
 */
export function commentIdFrom(url: string | null | undefined): string | null {
  if (!url) return null;
  const s = decodeHref(url);
  const reply = /replyUrn=urn:li:comment:\([^,)]+,(\d+)\)/.exec(s);
  if (reply) return reply[1]!;
  const comment = /commentUrn=urn:li:comment:\([^,)]+,(\d+)\)/.exec(s);
  if (comment) return comment[1]!;
  const any = /urn:li:comment:\([^,)]+,(\d+)\)/.exec(s);
  return any ? any[1]! : null;
}

/**
 * Candidate notification-card containers, broadest-last. LIVE-TUNE: a real
 * captured card is
 *   <article class="nt-card nt-card--unread …" data-view-name="notification-card-container">
 * — note the attribute value is "notification-card-CONTAINER"; the guessed
 * "notification-card" matched nothing.
 */
/** The anchor every notification card carries, whatever the notification is. */
const NOTIFICATION_LINK_SEL =
  "a.nt-card__headline, a[href*='highlightedUpdateUrn'], a[href*='/feed/update/'], a[href*='activity-']";

const CARD_SELECTORS = [
  "[data-view-name='notification-card-container']",
  "article.nt-card",
  ".nt-card",
  "article",
  "li",
];

function cardsIn(root: ParentNode): Element[] {
  for (const sel of CARD_SELECTORS) {
    const found = Array.from(root.querySelectorAll(sel));
    // Only accept a level that actually looks like notification cards: each one
    // must carry a post link. A bare `article`/`li` sweep would otherwise match
    // page chrome.
    // LIVE-TUNE: a REPLY card's headline links to
    // `/feed/?highlightedUpdateUrn=…`, NOT `/feed/update/…`. The first version
    // required the latter, so it matched only the impressions cards and found

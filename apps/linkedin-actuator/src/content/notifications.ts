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
    // ZERO actual replies — the LinkedIn sweep harvested nothing. Accept any
    // headline anchor, which is what actually identifies a notification card.
    const cards = found.filter((el) => el.querySelector(NOTIFICATION_LINK_SEL));
    // Keep only the INNERMOST matches. At the bare `article`/`li` fallback
    // levels a wrapper element also "contains a notification link" — it
    // contains all of them — so the list can come back as one container plus
    // the real cards nested inside it. That container harvests as a chimera: it
    // takes its identity (name, publicId, urn, external_id) from the first card
    // and, since the fields are read independently, can take its TIMESTAMP from
    // a different one — then dedups the real card away by external_id. A stale
    // reply wearing a fresh card's age is exactly what the window must prevent.
    // "Contains another card" only counts when that inner element is itself a
    // plausible card — it has its own headline anchor. Without that guard, a
    // real card holding any incidental notification link (a nested "see more")
    // would be discarded as a non-leaf in favour of a headline-less fragment,
    // and the harvest would silently drop to zero.
    const isCardLike = (el: Element) =>
      el.querySelector("a.nt-card__headline") !== null || el.querySelector(".nt-card__headline") !== null;
    const leaves = cards.filter((c) => !cards.some((o) => o !== c && c.contains(o) && isCardLike(o)));
    if (leaves.length > 0) return leaves;
  }
  return [];
}

/**
 * The COMMENT the card is about — the text we are answering.
 *
 * LIVE-TUNE, and the subtle part. A real card's body is:
 *   <button class="artdeco-card …">
 *     <div class="nt-card__text--2-line-large … t-black">   <- THE COMMENT
 *     <hr>
 *     <div class="nt-card-content__body--secondary">
 *       <div class="nt-card-content__body-text …">          <- the ORIGINAL POST
 *
 * The first version took the LONGEST leaf text, which on any real card is the
 * original post (often 1000+ chars) rather than the comment — so the drafter
 * would have been answering our own post instead of the person. The comment is
 * the body text that is NOT inside `.nt-card-content__body--secondary`.
 */
/**
 * Text that is LinkedIn's own furniture, not a human being.
 *
 * The notifications page renders control links inside the card region, and
 * "Change notification preferences" was harvested three times as somebody's
 * comment — then ingested, then drafted. Lyra was seconds from queueing a
 * thoughtful reply to a settings link. A reply lane must never treat page
 * chrome as a person.
 */
const UI_CHROME = [
  /^change notification preferences$/i,
  /^manage (your )?notifications?$/i,
  /^see all( notifications)?$/i,
  /^turn off this notification$/i,
  /^view all$/i,
  /^show more results?$/i,
  /^load more$/i,
  /^dismiss$/i,
  /^undo$/i,
];

/** Is this snippet page furniture rather than something a human wrote? */
export function isUiChrome(text: string): boolean {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  return UI_CHROME.some((re) => re.test(t));
}

export function cardSnippet(card: Element, headline: string): string {
  const normalized = headline.replace(/\s+/g, " ").trim();
  // Exclude the headline SUBTREE, not just text equal to the headline: the
  // headline anchor itself carries `nt-card__text--word-wrap`, so it matches
  // the body-text selector and — because its raw text still includes the
  // .visually-hidden "Unread notification." that cardHeadline strips — an
  // equality check against the headline does not catch it.
  const candidates = Array.from(
    card.querySelectorAll<HTMLElement>(".nt-card__text--2-line-large, .nt-card__text--word-wrap"),
  ).filter(
    (el) => !el.closest(".nt-card-content__body--secondary") && !el.closest(".nt-card__headline"),
  );
  for (const el of candidates) {
    const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!t || t.length < 3) continue;
    if (normalized.includes(t)) continue; // that's the headline itself
    return t;
  }
  // Drift fallback: longest leaf that isn't the headline, a timestamp, or the
  // secondary post-context block.
  let best = "";
  for (const el of Array.from(card.querySelectorAll<HTMLElement>("p, span, div"))) {
    if (el.children.length > 0) continue; // leaf text only
    if (el.closest(".nt-card-content__body--secondary")) continue;
    if (el.closest(".nt-card__headline")) continue;
    const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!t || t.length < 3) continue;
    if (normalized.includes(t)) continue;
    if (/^\d+\s*(m|h|d|w|mo|y)$/i.test(t)) continue; // "3h" timestamps
    if (t.length > best.length) best = t;
  }
  return best;
}

/**
 * The ORIGINAL POST text a card quotes underneath the comment, or "".
 * Free conversation context: `.nt-card-content__body-text` inside the
 * secondary block is the post the comment sits on.
 */
export function cardPostContext(card: Element): string {
  const el = card.querySelector<HTMLElement>(
    ".nt-card-content__body--secondary .nt-card-content__body-text",
  );
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The card's headline text — the line that says what happened.
 *
 * LIVE-TUNE: the real class is `nt-card__headline` on the <a>, NOT the guessed
 * `nt-card__text--headline` (which matches nothing). The anchor also contains a
 * `.visually-hidden` "Unread notification." paragraph that must be dropped, and
 * a `[class*='headline']` fallback would otherwise also match the settings
 * dropdown's `nt-card-settings-dropdown-item__headline` entries.
 */
export function cardHeadline(card: Element): string {
  const el =
    card.querySelector(".nt-card__headline") ??
    card.querySelector(".nt-card__text--headline") ??
    card.querySelector("a[class*='headline']") ??
    card;
  const clone = el.cloneNode(true) as Element;
  for (const hidden of Array.from(clone.querySelectorAll(".visually-hidden"))) hidden.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Only notifications from the last 12 hours are eligible.
 *
 * The seen-ring alone answers the wrong question. It is per-install and starts
 * empty, so a fresh profile's first sweep happily answers whatever is oldest on
 * the page — and a notifications list runs back days. Replying to a
 * two-day-old comment is necro-engagement: the thread has moved on and the
 * answer reads as a bot working through a backlog. Twelve hours covers a
 * normal night's sleep with room to spare, so a reply that lands at 1am is
 * still answerable well past 9am rather than having aged out while nobody was
 * watching.
 */
export const MAX_AGE_MINUTES = 720;

/**
 * Relative-age text → minutes. Unlike X (which renders a machine-readable
 * <time datetime>), LinkedIn only ever renders the rendered-for-humans form:
 * "6h", "2h", "1d", "3w". So we parse what the card says.
 *
 * Order matters: "mo" (months) has to be tested before "m" (minutes) or every
 * "3mo" would read as three minutes and a quarter-old notification would look
 * fresh. Anything unrecognised is null, never a guess.
 */
/**
 * Every rule is anchored at BOTH ends. That is not tidiness, it is the whole
 * safety property: a start-anchored `/^(\d+)\s*s/` happily reads the Spanish
 * "3 sem" (three WEEKS) as three seconds, and `/^(\d+)\s*m/` reads "1 mes"
 * (one MONTH) as one minute. Both land at ~0 minutes — "just now" — so a
 * months-old thread would sail through the window and get answered.
 *
 * The harvest itself is language-independent (it keys on the
 * `highlightedUpdateType` param, not on prose), so the sweep really does run on
 * a non-English UI even though the rest of the actuator's selectors are
 * English. Anchoring makes every unrecognised form null — skip, never a guess.
 */
const AGE_UNITS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(\d+)\s*mo(?:s|nths?)?(?:\s+ago)?$/i, 43_200], // months — MUST precede minutes
  [/^(\d+)\s*(?:s|secs?|seconds?)(?:\s+ago)?$/i, 0],
  [/^(\d+)\s*(?:m|mins?|minutes?)(?:\s+ago)?$/i, 1],
  [/^(\d+)\s*(?:h|hrs?|hours?)(?:\s+ago)?$/i, 60],
  [/^(\d+)\s*(?:d|days?)(?:\s+ago)?$/i, 1_440],
  [/^(\d+)\s*(?:w|wks?|weeks?)(?:\s+ago)?$/i, 10_080],
  [/^(\d+)\s*(?:y|yrs?|years?)(?:\s+ago)?$/i, 525_600],
];

/**
 * Subtrees that hold HUMAN-WRITTEN text: the comment snippet and the quoted
 * post. The structural fallback must never read an age out of these — "5 min"
 * is an ordinary thing for somebody to reply, and reading it as the card's age
 * would make a two-day-old comment look five minutes old.
 */
const HUMAN_TEXT_SEL =
  ".nt-card-content__body, .nt-card-content__body-text, .nt-card__text--word-wrap, [class*='body-text']";

/** Parse LinkedIn's relative age text into minutes. null when unreadable. */
export function ageMinutesFromText(text: string | null | undefined): number | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (/^now$/i.test(t) || /^just now$/i.test(t)) return 0;
  for (const [re, unit] of AGE_UNITS) {
    const m = re.exec(t);
    if (m) return Number(m[1]) * unit;
  }
  return null;
}

/**

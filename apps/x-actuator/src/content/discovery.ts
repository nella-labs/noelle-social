import { readSelfHandle } from "./notifications.js";
import { findFeedTweets, isPromoted, isTruncated, tweetAuthorHandle } from "./selectors.js";

/** One currently visible X post, ready for server-side Jev qualification. */
export interface VisibleTweet {
  tweetId: string;
  url: string;
  text: string;
  authorHandle: string;
  authorName?: string;
  authorId?: string;
  postedAt?: string;
  likeCount?: number;
  replyCount?: number;
}

const STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/;

function statusLink(tweet: Element, handle: string, pageHref: string): { tweetId: string; url: string; postedAt?: string } | null {
  const name = tweet.querySelector("[data-testid='User-Name']");
  // Feed cards carry their own permalink in the outer User-Name. A quote can
  // add another timestamp later in the article, so prefer this scoped link.
  if (!name) return null;
  const links = Array.from(name.querySelectorAll<HTMLAnchorElement>("a[href*='/status/']"));
  for (const anchor of links) {
    let parsed: URL;
    try { parsed = new URL(anchor.getAttribute("href") ?? "", "https://x.com"); }
    catch { continue; }
    if (parsed.hostname !== "x.com" && parsed.hostname !== "twitter.com") continue;
    const match = STATUS_PATH.exec(parsed.pathname);
    if (!match || match[1]!.toLowerCase() !== handle.toLowerCase()) continue;
    const rawDate = anchor.querySelector("time[datetime]")?.getAttribute("datetime");
    return {
      tweetId: match[2]!,
      url: `https://x.com/${match[1]}/status/${match[2]}`,
      // Preserve source evidence; the server owns calendar validation.
      ...(rawDate ? { postedAt: rawDate } : {}),
    };
  }

  // On current permalink pages the focal post's status/time anchor is outside
  // User-Name. Only accept a link matching this page's exact status path,
  // authored by the outer header, and outside any embedded quote/article.
  let page: URL;
  try { page = new URL(pageHref); }
  catch { return null; }
  if (page.hostname !== "x.com" && page.hostname !== "twitter.com") return null;
  const pageMatch = STATUS_PATH.exec(page.pathname);
  if (!pageMatch || pageMatch[1]!.toLowerCase() !== handle.toLowerCase()) return null;
  if (name.closest("[data-testid='quoteTweet']") || name.closest("article[data-testid='tweet']") !== tweet) return null;
  const profile = Array.from(name.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .some((anchor) => anchor.getAttribute("href")?.toLowerCase() === `/${handle.toLowerCase()}`);
  if (!profile) return null;
  for (const anchor of tweet.querySelectorAll<HTMLAnchorElement>("a[href*='/status/']")) {
    if (anchor.closest("[data-testid='quoteTweet']") || anchor.closest("article[data-testid='tweet']") !== tweet) continue;
    const href = anchor.getAttribute("href") ?? "";
    if (href !== `/${pageMatch[1]}/status/${pageMatch[2]}`) continue;
    const rawDate = anchor.querySelector("time[datetime]")?.getAttribute("datetime");
    return {
      tweetId: pageMatch[2]!,
      url: `https://x.com/${pageMatch[1]}/status/${pageMatch[2]}`,
      ...(rawDate ? { postedAt: rawDate } : {}),
    };
  }
  return null;
}

function inViewport(tweet: Element): boolean {
  const win = tweet.ownerDocument.defaultView;
  if (!win) return false;
  const style = win.getComputedStyle(tweet);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = tweet.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < win.innerHeight
    && rect.right > 0 && rect.left < win.innerWidth;
}

function bodyText(tweet: Element): string {
  const body = tweet.querySelector<HTMLElement>("[data-testid='tweetText']");
  if (!body) return "";
  // X keeps text under the first tweetText and quotes under a later one. Read
  // text nodes directly so line breaks survive even when innerText is absent.
  let result = "";
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { result += node.textContent ?? ""; return; }
    if (!(node instanceof Element)) return;
    if (node.matches("[data-testid='tweet-text-show-more-link']")) return;
    if (node.tagName === "BR") { result += "\n"; return; }
    for (const child of node.childNodes) walk(child);
  };
  walk(body);
  return result.replace(/\r/g, "").split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean).join("\n");
}

function displayName(tweet: Element, handle: string): string | undefined {
  const name = tweet.querySelector("[data-testid='User-Name']");
  if (!name) return undefined;
  for (const anchor of name.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (anchor.getAttribute("href")?.toLowerCase() !== `/${handle.toLowerCase()}`) continue;
    const value = (anchor.textContent ?? "").trim();
    if (value && !value.startsWith("@")) return value;
  }
  return undefined;
}

function hasReplyContext(tweet: Element): boolean {
  const body = tweet.querySelector("[data-testid='tweetText']");
  // Current search cards put an anonymous "Replying to @account" line before
  // the body. A post body or a nested quote can contain the same words.
  for (const line of tweet.querySelectorAll("div[dir='ltr']")) {
    if (line.closest("[data-testid='tweetText'], [data-testid='quoteTweet']")) continue;
    if (body && (body.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (!/^Replying to\s+/i.test((line.textContent ?? "").trim())) continue;
    const accountLink = Array.from(line.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .some((anchor) => /^\/[A-Za-z0-9_]{1,15}\/?$/.test(anchor.getAttribute("href") ?? "")
        && /^@[A-Za-z0-9_]{1,15}$/.test((anchor.textContent ?? "").trim()));
    if (accountLink) return true;
  }
  return false;
}

function parseCount(value: string): number | undefined {
  const match = /^([\d,.]+)\s*([kKmMbB]?)$/.exec(value.trim());
  if (!match) return undefined;
  const multiplier = { "": 1, k: 1_000, m: 1_000_000, b: 1_000_000_000 }[match[2]!.toLowerCase() as "" | "k" | "m" | "b"];
  const amount = Number(match[1]!.replace(/,/g, "")) * multiplier;
  return Number.isFinite(amount) ? Math.round(amount) : undefined;
}

function engagement(tweet: Element, kind: "Replies" | "Likes"): number | undefined {
  const word = kind === "Replies" ? "repl(?:y|ies)" : "likes?";
  const action = kind === "Replies" ? "reply" : "like";
  const pattern = new RegExp(`([\\d,.]+\\s*[kKmMbB]?)\\s+${word}\\b`, "i");
  const button = tweet.querySelector(`[data-testid='${action}'], [data-testid='${action === "like" ? "unlike" : action}']`);
  const label = button?.getAttribute("aria-label") ?? "";
  const fromButton = pattern.exec(label);
  if (fromButton) return parseCount(fromButton[1]!);
  // The group label duplicates action counts on current X; use it when an
  // individual icon has no label, without scraping the tweet body.
  const group = tweet.querySelector("[role='group'][aria-label]")?.getAttribute("aria-label") ?? "";
  const fromGroup = pattern.exec(group);
  return fromGroup ? parseCount(fromGroup[1]!) : undefined;
}

/** Read only the cards that the actor can currently see, at its existing pace. */
export function harvestVisibleTweets(
  root: ParentNode,
  selfHandle = readSelfHandle(root),
  pageHref = root instanceof Document ? root.location.href : (root as Node).ownerDocument?.location.href ?? "",
): VisibleTweet[] {
  // Without the account identity we cannot safely exclude our own posts.
  if (!selfHandle) return [];
  const out = new Map<string, VisibleTweet>();
  for (const tweet of findFeedTweets(root)) {
    // The feed DOM only has an excerpt until Show more is opened. Wait for the
    // actor's existing expand action rather than qualifying incomplete text.
    if (!inViewport(tweet) || isPromoted(tweet) || isTruncated(tweet) || hasReplyContext(tweet)) continue;
    const authorHandle = tweetAuthorHandle(tweet);
    if (!authorHandle || authorHandle.toLowerCase() === selfHandle.toLowerCase()) continue;
    const identity = statusLink(tweet, authorHandle, pageHref);
    const text = bodyText(tweet);
    if (!identity || !text || out.has(identity.tweetId)) continue;
    const name = displayName(tweet, authorHandle);
    const likeCount = engagement(tweet, "Likes");
    const replyCount = engagement(tweet, "Replies");
    out.set(identity.tweetId, {
      ...identity,
      text,
      authorHandle,
      ...(name ? { authorName: name } : {}),
      ...(likeCount !== undefined ? { likeCount } : {}),
      ...(replyCount !== undefined ? { replyCount } : {}),
    });
    if (out.size >= 50) break;
  }
  return [...out.values()];
}

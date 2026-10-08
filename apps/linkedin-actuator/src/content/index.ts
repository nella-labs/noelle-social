import { makeRng } from "../lib/rng.js";
import {
  locateCommentReplyButton,
  locateReplyComposer,
  locateReplySubmit,
  readReplyComposer,
  locateLoadMoreComments,
} from "./comment-threading.js";
import { locateLikeTarget, locateCommentBox, locatePostCommentAction, locateCommentSubmit, diagnoseCommentSubmit, readCommentBox, locateMessageCompose, readMessageCompose, locateMessageSend, locateAmbientExpand, locateAmbientComments, locatePostLike, locateReaction, detectChallenge, detectPostUnavailable, detectCommentRestricted } from "./locators.js";
import type { ReactionType } from "../lib/reactions.js";
import { mountPanel } from "./panel.js";
import { countNotificationCards, harvestNotifications } from "./notifications.js";
import { harvestVisiblePosts, locateDiscoveryCopyLink, locateDiscoveryPostMenu, readDiscoveryMenuShareUrn } from "./discovery.js";

type Msg =
  | { cmd: "locateLike"; preferWatchlist: boolean; watchlistNames: string[] }
  | { cmd: "locateReaction"; reaction: ReactionType }
  | { cmd: "locateCommentBox" }
  | { cmd: "locatePostCommentAction" }
  // ── comment-level threading (answering the person who replied to us) ──
  | { cmd: "locateCommentReply"; commentUrn: string }
  | { cmd: "locateReplyComposer"; commentUrn: string }
  | { cmd: "locateReplySubmit"; commentUrn: string; expectMention?: string }
  | { cmd: "readReplyComposer"; commentUrn: string }
  | { cmd: "locateLoadMoreComments" }
  | { cmd: "locateCommentSubmit" }
  | { cmd: "diagnoseCommentSubmit" }
  | { cmd: "readCommentBox" }
  | { cmd: "locateMessageCompose" }
  | { cmd: "readMessageCompose" }
  | { cmd: "locateMessageSend" }
  | { cmd: "locateAmbientExpand" }
  | { cmd: "locateAmbientComments" }
  | { cmd: "locatePostLike" }
  | { cmd: "detectChallenge" }
  | { cmd: "detectPostUnavailable" }
  | { cmd: "detectCommentRestricted" }
  // Notifications actor: a read-only scrape of the notifications page. It never clicks.
  | { cmd: "harvestNotifications" }
  | { cmd: "harvestVisiblePosts" }
  | { cmd: "locateDiscoveryPostMenu"; fingerprint: string }
  | { cmd: "locateDiscoveryCopyLink" }
  | { cmd: "readDiscoveryMenuShareUrn" }
  | { cmd: "ping" };

// Called synchronously from the wxt content-script entrypoint's main(). Kept as
// a function (not top-level side effects) so the entrypoint can import it
// statically — a dynamic import() in a content script tries to fetch a chunk
// over chrome-extension:// and fails ("chrome-extension://invalid") when the
// chunk isn't web-accessible, which silently skips the panel mount.
export function initContent(): void {
  const rng = makeRng((Date.now() & 0xffffffff) >>> 0);

  chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
    switch (msg.cmd) {
      case "ping": sendResponse({ ok: true }); break;
      case "detectChallenge": sendResponse({ ok: true, observed: { challenge: detectChallenge(document.body) } }); break;
      case "detectPostUnavailable": sendResponse({ ok: true, observed: { unavailable: detectPostUnavailable(document.body) } }); break;
      case "detectCommentRestricted": sendResponse({ ok: true, observed: { restricted: detectCommentRestricted(document.body) } }); break;
      case "locateLike": sendResponse(locateLikeTarget(document.body, { preferWatchlist: msg.preferWatchlist, watchlistNames: msg.watchlistNames }, rng)); break;
      case "locateReaction": sendResponse(locateReaction(document.body, msg.reaction)); break;
      case "locateCommentBox": sendResponse(locateCommentBox(document.body)); break;
      case "locatePostCommentAction": sendResponse(locatePostCommentAction(document.body)); break;
      // Comment-level threading. Every one of these REFUSES rather than falling
      // back to the post composer — a conversation reply published at post level
      // is a duplicate top-level comment on a thread we already commented on.
      case "locateCommentReply":
        sendResponse(locateCommentReplyButton(document.body, msg.commentUrn));
        break;
      case "locateReplyComposer":
        sendResponse(locateReplyComposer(document.body, { afterCommentId: msg.commentUrn }));
        break;
      case "locateReplySubmit":
        sendResponse(
          locateReplySubmit(document.body, {
            afterCommentId: msg.commentUrn,
            ...(msg.expectMention ? { expectMention: msg.expectMention } : {}),
          }),
        );
        break;
      case "locateLoadMoreComments": sendResponse(locateLoadMoreComments(document.body)); break;
      case "readReplyComposer":
        sendResponse(readReplyComposer(document.body, { afterCommentId: msg.commentUrn }));
        break;
      case "locateCommentSubmit": sendResponse(locateCommentSubmit(document.body)); break;
      case "diagnoseCommentSubmit": sendResponse(diagnoseCommentSubmit(document.body)); break;
      case "readCommentBox": sendResponse(readCommentBox(document.body)); break;
      case "locateMessageCompose": sendResponse(locateMessageCompose(document.body)); break;
      case "readMessageCompose": sendResponse(readMessageCompose(document.body)); break;
      case "locateMessageSend": sendResponse(locateMessageSend(document.body)); break;
      case "locateAmbientExpand": sendResponse(locateAmbientExpand(document.body, rng)); break;
      case "locateAmbientComments": sendResponse(locateAmbientComments(document.body, rng)); break;
      case "locatePostLike": sendResponse(locatePostLike(document.body)); break;
      case "harvestNotifications":
        // `cards` counts EVERY notification card, `items` only the replies. The
        // sweep needs both to tell "nobody replied to me" (ordinary) apart from
        // "the page rendered nothing" (a markup break).
        sendResponse({
          ok: true,
          items: harvestNotifications(document.body),
          cards: countNotificationCards(document.body),
        });
        break;
      case "harvestVisiblePosts":
        sendResponse({ ok: true, items: harvestVisiblePosts(document.body) });
        break;
      case "locateDiscoveryPostMenu":
        sendResponse(locateDiscoveryPostMenu(document.body, msg.fingerprint));
        break;
      case "locateDiscoveryCopyLink":
        sendResponse(locateDiscoveryCopyLink(document.body));
        break;
      case "readDiscoveryMenuShareUrn":
        sendResponse(readDiscoveryMenuShareUrn(document.body));
        break;
    }
    return true; // async-capable response
  });

  // body may not exist yet at document_start; mount as soon as it does.
  if (document.body) mountPanel();
  else document.addEventListener("DOMContentLoaded", () => mountPanel(), { once: true });
}

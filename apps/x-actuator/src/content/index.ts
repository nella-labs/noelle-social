import { makeRng } from "../lib/rng.js";
import { locateLikeTarget, locateCommentBox, locateCommentSubmit, diagnoseCommentSubmit, readCommentBox, locatePostLike, locateAmbientExpand, locateAmbientComments, locateEngagement, locateRepostConfirm, detectChallenge, detectPostUnavailable, detectReplyRestricted } from "./locators.js";
import type { EngagementKind } from "../lib/engagement.js";
import { mountPanel } from "./panel.js";
import { harvestNotifications, harvestThread, readSelfHandle } from "./notifications.js";
import { harvestVisibleTweets } from "./discovery.js";

// Command names are the actuator protocol inherited from the LinkedIn
// actuator — "comment" == X reply. There are deliberately NO DM commands
// (locateMessageCompose/locateMessageSend): X DMs stay manual.
type Msg =
  | { cmd: "locateLike"; preferWatchlist: boolean; watchlistNames: string[] }
  | { cmd: "locateEngagement"; engagement: EngagementKind; tweet_id: string | null }
  | { cmd: "locateRepostConfirm" }
  | { cmd: "locateCommentBox" }
  | { cmd: "locateCommentSubmit" }
  | { cmd: "diagnoseCommentSubmit" }
  | { cmd: "readCommentBox" }
  | { cmd: "locatePostLike"; tweetId?: string | null }
  | { cmd: "locateAmbientExpand" }
  | { cmd: "locateAmbientComments" }
  | { cmd: "detectChallenge" }
  | { cmd: "detectPostUnavailable" }
  | { cmd: "detectReplyRestricted" }
  // Notifications actor: read-only scrapes. "harvestNotifications" reads the
  // mentions timeline, "harvestThread" reads the ancestor chain on a permalink
  // page, "readSelfHandle" names the logged-in account. None of them click.
  | { cmd: "harvestNotifications" }
  | { cmd: "harvestThread"; focusTweetId: string }
  | { cmd: "readSelfHandle" }
  | { cmd: "harvestVisibleTweets" }
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
      case "detectReplyRestricted": sendResponse({ ok: true, observed: { restricted: detectReplyRestricted(document.body) } }); break;
      case "locateLike": sendResponse(locateLikeTarget(document.body, { preferWatchlist: msg.preferWatchlist, watchlistNames: msg.watchlistNames }, rng)); break;
      case "locateEngagement": sendResponse(locateEngagement(document.body, msg.engagement, msg.tweet_id)); break;
      case "locateRepostConfirm": sendResponse(locateRepostConfirm(document.body)); break;
      case "locateCommentBox": sendResponse(locateCommentBox(document.body)); break;
      case "locateCommentSubmit": sendResponse(locateCommentSubmit(document.body)); break;
      case "diagnoseCommentSubmit": sendResponse(diagnoseCommentSubmit(document.body)); break;
      case "readCommentBox": sendResponse(readCommentBox(document.body)); break;
      case "locatePostLike": sendResponse(locatePostLike(document.body, msg.tweetId)); break;
      case "locateAmbientExpand": sendResponse(locateAmbientExpand(document.body, rng)); break;
      case "locateAmbientComments": sendResponse(locateAmbientComments(document.body, rng)); break;
      case "harvestNotifications": sendResponse({ ok: true, items: harvestNotifications(document.body) }); break;
      case "harvestThread": sendResponse({ ok: true, chain: harvestThread(document.body, msg.focusTweetId) }); break;
      case "readSelfHandle": sendResponse({ ok: true, handle: readSelfHandle(document.body) }); break;
      case "harvestVisibleTweets": sendResponse({ ok: true, items: harvestVisibleTweets(document.body) }); break;
    }
    return true; // async-capable response
  });

  // body may not exist yet at document_start; mount as soon as it does.
  if (document.body) mountPanel();
  else document.addEventListener("DOMContentLoaded", () => mountPanel(), { once: true });
}

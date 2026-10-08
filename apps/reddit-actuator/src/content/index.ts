import { makeRng } from "../lib/rng.js";
import {
  locateComposerEntry, locateCommentReplyButton, locateReplyBox, locateDirtyReplyBox, locateReplySubmit, readReplyBox,
  diagnoseReplySubmit,
  locateAmbientExpand, locateAmbientComments, locateUpvote, locateSave, locateSaveInMenu,
  detectChallenge, verifyReplyCleared,
  checkPostRemoved, checkCommentsLocked,
} from "./locators.js";
import { mountPanel } from "./panel.js";

// The Reddit actuator message protocol. The content script is a passive DOM
// oracle: it LOCATES elements and reports {ok,x,y,rect,observed,skipReason}; the
// background performs every click/keystroke via trusted CDP input. Writes are
// REPLY + operator-opt-in UPVOTE only (locateUpvote) — UPVOTE-ONLY, there is
// deliberately NO downvote command anywhere.
type Msg =
  | { cmd: "ping" }
  | { cmd: "detectChallenge" }
  | { cmd: "checkPostRemoved" }
  | { cmd: "checkCommentsLocked" }
  | { cmd: "locateComposerEntry" }
  | { cmd: "locateCommentReplyButton"; commentId?: string }
  | { cmd: "locateReplyBox"; commentId?: string }
  | { cmd: "locateDirtyReplyBox"; scroll?: boolean; ownBody?: string }
  | { cmd: "locateReplySubmit"; commentId?: string }
  | { cmd: "readReplyBox"; commentId?: string }
  | { cmd: "diagnoseReplySubmit"; commentId?: string }
  | { cmd: "verifyReplyPosted"; commentId?: string }
  | { cmd: "locateUpvote" }
  | { cmd: "locateSave" }
  | { cmd: "locateSaveInMenu" }
  | { cmd: "locateAmbientExpand" }
  | { cmd: "locateAmbientComments" };

// Called synchronously from the wxt content-script entrypoint's main(). Kept as
// a function (not top-level side effects) so the entrypoint can import it
// statically — a dynamic import() in a content script tries to fetch a chunk
// over chrome-extension:// and fails ("chrome-extension://invalid") when the
// chunk isn't web-accessible, which silently skips the panel mount.
export function initContent(): void {
  const rng = makeRng((Date.now() & 0xffffffff) >>> 0);
  const hostname = (): string | undefined => (typeof location !== "undefined" ? location.hostname : undefined);

  chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
    switch (msg.cmd) {
      case "ping":
        sendResponse({ ok: true });
        break;
      case "detectChallenge":
        sendResponse({
          ok: true,
          observed: detectChallenge(document.body, {
            url: typeof location !== "undefined" ? location.href : "",
            title: typeof document !== "undefined" ? document.title : "",
          }),
        });
        break;
      case "checkPostRemoved":
        sendResponse(checkPostRemoved(document.body, hostname()));
        break;
      case "checkCommentsLocked":
        sendResponse(checkCommentsLocked(document.body, hostname()));
        break;
      case "locateComposerEntry":
        sendResponse(locateComposerEntry(document.body, hostname()));
        break;
      case "locateCommentReplyButton":
        sendResponse(locateCommentReplyButton(document.body, msg.commentId, hostname()));
        break;
      case "locateReplyBox":
        sendResponse(locateReplyBox(document.body, hostname(), msg.commentId));
        break;
      case "locateDirtyReplyBox":
        sendResponse(locateDirtyReplyBox(document.body, hostname(), msg.scroll !== false, msg.ownBody));
        break;
      case "locateReplySubmit":
        sendResponse(locateReplySubmit(document.body, hostname(), msg.commentId));
        break;
      case "readReplyBox":
        sendResponse(readReplyBox(document.body, hostname(), msg.commentId));
        break;
      case "diagnoseReplySubmit":
        sendResponse(
          diagnoseReplySubmit(
            document.body, hostname(), msg.commentId,
            typeof location !== "undefined" ? location.pathname : undefined,
          ),
        );
        break;
      case "verifyReplyPosted": // exact composer presence and empty evidence
        sendResponse({ ok: true, ...verifyReplyCleared(document.body, hostname(), msg.commentId) });
        break;
      case "locateUpvote":
        sendResponse(locateUpvote(document.body, rng, hostname()));
        break;
      case "locateSave":
        sendResponse(locateSave(document.body, rng, hostname()));
        break;
      case "locateSaveInMenu":
        sendResponse(locateSaveInMenu(document.body, hostname()));
        break;
      case "locateAmbientExpand":
        sendResponse(locateAmbientExpand(document.body, rng, hostname()));
        break;
      case "locateAmbientComments":
        sendResponse(locateAmbientComments(document.body, rng, hostname()));
        break;
    }
    return true; // async-capable response
  });

  // body may not exist yet at document_start; mount as soon as it does.
  if (document.body) mountPanel();
  else document.addEventListener("DOMContentLoaded", () => mountPanel(), { once: true });
}

// The XClient adapter moved to @noelle/x-client so apps/api-vm can post
// to X synchronously from POST /api/drafts/:id/send. This file remains as
// a re-export so the workers' existing `./x-client.js` imports keep working.
//
// Look in packages/x-client/src/index.ts for the implementation.

export {
  XError,
  XAuthError,
  XRateLimitError,
  XLockError,
  XChallengeError,
  XReplyRestrictedError,
  createXClient,
  type XTweet,
  type XClient,
  type CreateXClientOpts,
  type BirdLike,
} from "@noelle/x-client";

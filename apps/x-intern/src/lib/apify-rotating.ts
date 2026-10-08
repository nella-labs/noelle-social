import { ApifyXError, type ApifyXClient, X_SCRAPER_ACTOR, X_FOLLOWER_ACTOR } from "@noelle/x-apify";
import { apifyExhaustedMessage, createApifyRotation, isApifyTokenFatalStatus,
  type ApifyRotationDeps } from "@noelle/runtime/apify-rotation";
export type { RotatingTokenCandidate } from "@noelle/runtime/apify-rotation";

export class AllApifyTokensExhaustedError extends Error {
  constructor(readonly tokenCount: number, lastMessage: string) {
    super(apifyExhaustedMessage(tokenCount, lastMessage));
    this.name = "AllApifyTokensExhaustedError";
  }
}
export function isTokenFatalError(error: unknown): boolean {
  return error instanceof ApifyXError && isApifyTokenFatalStatus(error.status);
}
export interface RotatingApifyClient extends ApifyXClient {
  currentCredentialId(): string | null;
  /** Total received charge; null when canonical run usage is incomplete. */
  drainLastRunUsd(): number | null;
  /** Independent charge state with the same shared dead-token policy. */
  isolateOperation(): RotatingApifyClient;
}
export type CreateRotatingApifyClientDeps = ApifyRotationDeps<ApifyXClient>;

export function createRotatingApifyClient(deps: CreateRotatingApifyClientDeps): RotatingApifyClient {
  const rotation = createApifyRotation(deps, {
    fatalStatus: error => isTokenFatalError(error) ? (error as ApifyXError).status : null,
    exhaustedError: (count, detail) => new AllApifyTokensExhaustedError(count, detail),
    limitError: () => new ApifyXError("Apify token attempt limit exceeded", 429),
    acceptLegacyFailedUsage: true,
  });
  function facade(scope: typeof rotation): RotatingApifyClient {
    return {
      userTweets: args => scope.run(client => client.userTweets(args), X_SCRAPER_ACTOR),
      searchTimeline: args => scope.run(client => client.searchTimeline(args), X_SCRAPER_ACTOR),
      conversationReplies: args => scope.run(client => client.conversationReplies(args), X_SCRAPER_ACTOR),
      scrapeFollowers: args => scope.run(client => client.scrapeFollowers(args), X_FOLLOWER_ACTOR),
      drainRunReceipts: scope.drainRunReceipts,
      drainLastRunUsd: scope.drainLastRunUsd,
      currentCredentialId: scope.currentCredentialId,
      isolateOperation: () => facade(scope.fork()),
    };
  }
  return facade(rotation);
}

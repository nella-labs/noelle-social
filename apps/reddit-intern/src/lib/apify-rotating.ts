import { ApifyError, type ApifyRedditClient } from "@noelle/reddit-apify";
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
  return error instanceof ApifyError && isApifyTokenFatalStatus(error.status);
}
export interface RotatingApifyClient extends ApifyRedditClient {
  currentCredentialId(): string | null;
  /** Total received charge; null when canonical run usage is incomplete. */
  drainLastRunUsd(): number | null;
  /** Independent charge state with the same shared dead-token policy. */
  isolateOperation(): RotatingApifyClient;
}
export type CreateRotatingApifyClientDeps = ApifyRotationDeps<ApifyRedditClient>;

export function createRotatingApifyClient(deps: CreateRotatingApifyClientDeps): RotatingApifyClient {
  const rotation = createApifyRotation(deps, {
    fatalStatus: error => isTokenFatalError(error) ? (error as ApifyError).status : null,
    exhaustedError: (count, detail) => new AllApifyTokensExhaustedError(count, detail),
    limitError: () => new ApifyError("Apify token attempt limit exceeded", 429),
  });
  function facade(scope: typeof rotation): RotatingApifyClient {
    return {
      subredditPosts: args => scope.run(client => client.subredditPosts(args), "reddit-posts-comments-scraper"),
      drainRunReceipts: scope.drainRunReceipts,
      drainLastRunUsd: scope.drainLastRunUsd,
      currentCredentialId: scope.currentCredentialId,
      isolateOperation: () => facade(scope.fork()),
    };
  }
  return facade(rotation);
}

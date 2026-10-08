import { ApifyError, type ApifyLinkedInClient } from "@noelle/linkedin-apify";
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
export interface RotatingApifyClient extends ApifyLinkedInClient {
  currentCredentialId(): string | null;
  /** Total received charge; null when canonical run usage is incomplete. */
  drainLastRunUsd(): number | null;
  /** Independent charge state with the same shared dead-token policy. */
  isolateOperation(): RotatingApifyClient;
}
export type CreateRotatingApifyClientDeps = ApifyRotationDeps<ApifyLinkedInClient>;

export function createRotatingApifyClient(deps: CreateRotatingApifyClientDeps): RotatingApifyClient {
  const rotation = createApifyRotation(deps, {
    fatalStatus: error => isTokenFatalError(error) ? (error as ApifyError).status : null,
    exhaustedError: (count, detail) => new AllApifyTokensExhaustedError(count, detail),
    limitError: () => new ApifyError("Apify token attempt limit exceeded", 429),
  });
  function facade(scope: typeof rotation): RotatingApifyClient {
    return {
      profilePosts: args => scope.run(client => client.profilePosts(args), "linkedin-profile-posts"),
      searchPosts: args => scope.run(client => client.searchPosts(args), "linkedin-post-search"),
      searchProfiles: args => scope.run(client => client.searchProfiles(args), "linkedin-profile-search"),
      postComments: args => scope.run(client => client.postComments(args), "linkedin-post-comments"),
      authoredComments: args => scope.run(client => client.authoredComments(args), "linkedin-profile-comments"),
      drainRunReceipts: scope.drainRunReceipts,
      drainLastRunUsd: scope.drainLastRunUsd,
      currentCredentialId: scope.currentCredentialId,
      isolateOperation: () => facade(scope.fork()),
    };
  }
  return facade(rotation);
}

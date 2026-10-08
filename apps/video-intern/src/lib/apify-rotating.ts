import { ApifyError, isRetryableActorFailure, type ApifyVideoClient, type VideoPlatform } from "@noelle/video-apify";
export { isRetryableActorFailure } from "@noelle/video-apify";
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
export interface RotatingApifyClient extends ApifyVideoClient {
  currentCredentialId(): string | null;
  /** Total received charge; null when canonical run usage is incomplete. */
  drainLastRunUsd(): number | null;
  /** Independent charge state with the same shared dead-token policy. */
  isolateOperation(): RotatingApifyClient;
}
export type CreateRotatingApifyClientDeps = ApifyRotationDeps<ApifyVideoClient>;

export function defaultVideoApifyActor(platform: VideoPlatform): string {
  return platform === "instagram" ? "instagram-scraper" : "tiktok-scraper";
}
export function createRotatingApifyClient(deps: CreateRotatingApifyClientDeps): RotatingApifyClient {
  const rotation = createApifyRotation(deps, {
    fatalStatus: error => isTokenFatalError(error) ? (error as ApifyError).status : null,
    exhaustedError: (count, detail) => new AllApifyTokensExhaustedError(count, detail),
    limitError: () => new ApifyError("Apify token attempt limit exceeded", 429),
    retryActor: isRetryableActorFailure, maxActorRetries: 3,
  });
  function facade(scope: typeof rotation): RotatingApifyClient {
    return {
      creatorReels: args => scope.run(client => client.creatorReels(args), defaultVideoApifyActor(args.platform)),
      hashtagReels: args => scope.run(client => client.hashtagReels(args), defaultVideoApifyActor(args.platform)),
      nicheCreatorReels: args => scope.run(client => client.nicheCreatorReels(args), defaultVideoApifyActor(args.platform)),
      accountSnapshot: args => scope.run(client => client.accountSnapshot(args), defaultVideoApifyActor(args.platform)),
      drainRunReceipts: scope.drainRunReceipts,
      drainLastRunUsd: scope.drainLastRunUsd,
      currentCredentialId: scope.currentCredentialId,
      isolateOperation: () => facade(scope.fork()),
    };
  }
  return facade(rotation);
}

import type { Sql } from "postgres";
import { createXApiClient, makeRefreshCoordinator, type XWriteClient } from "@noelle/x-client";
import { saveRefreshedXApiTokens, type XApiTokenRow } from "./x-api-tokens.js";

/**
 * Build the official X API client for one agent instance from its stored tokens.
 *
 * Extracted from content-publish.ts so the own-account sweep (ideation.ts) can
 * reuse it rather than adding a third copy of this construction. The SEND worker
 * still has its own inline copy on purpose: its variant only builds an OAuth2
 * client when `authKind === "oauth2" && accessToken && (consumerKey || env id)`,
 * and a null client there falls through to a different path, so folding it in
 * would change send behaviour for a refactor's sake.
 *
 * The returned client serves the content publisher and own-account read sweep.
 * Callers enforce their worker consent, write switch and shared write budget
 * before dispatching a post.
 */
export async function buildXApiClient(args: {
  sql: Sql;
  instanceId: string;
  tokens: XApiTokenRow;
  /** Used when the token row carries no consumer key/secret of its own. */
  envClientId?: string | undefined;
  envClientSecret?: string | undefined;
  /** Handle to use when the token row has none (for building result URLs). */
  handleFallback?: string | null;
  /** Needs `error` too: makeRefreshCoordinator logs failed token rotations. */
  log: {
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}): Promise<XWriteClient | null> {
  const { sql, instanceId, tokens, log } = args;
  const handle = tokens.xHandle ?? args.handleFallback ?? null;
  try {
    // OAuth 1.0a (Consumer Key/Secret + Access Token/Secret) — long-lived, HMAC-signed.
    if (tokens.authKind === "oauth1a" && tokens.consumerKey && tokens.consumerSecret && tokens.accessTokenSecret) {
      return createXApiClient({
        oauth1a: {
          consumerKey: tokens.consumerKey,
          consumerSecret: tokens.consumerSecret,
          accessToken: tokens.accessToken,
          accessTokenSecret: tokens.accessTokenSecret,
        },
        role: "x_intern",
        sendEnabled: true, // gated by isWorkerEnabled + x_api_write_enabled at the call site
        xApiWriteEnabled: true,
        handle,
      });
    }
    // OAuth2 user-context (Bearer + refresh). The refresh coordinator serializes
    // + persists rotation under an advisory lock so no two processes race the
    // single-use refresh token.
    return createXApiClient({
      tokens: {
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
      },
      role: "x_intern",
      sendEnabled: true,
      xApiWriteEnabled: true,
      ...(tokens.consumerKey || args.envClientId
        ? { clientId: tokens.consumerKey ?? args.envClientId }
        : {}),
      ...(tokens.consumerSecret || args.envClientSecret
        ? { clientSecret: tokens.consumerSecret ?? args.envClientSecret }
        : {}),
      refreshCoordinator: makeRefreshCoordinator(sql, instanceId, log),
      handle,
      onTokensRefreshed: (t) => saveRefreshedXApiTokens(sql, instanceId, t),
    });
  } catch (e) {
    log.warn({ err: (e as Error).message, instance: instanceId }, "x api client construct failed");
    return null;
  }
}

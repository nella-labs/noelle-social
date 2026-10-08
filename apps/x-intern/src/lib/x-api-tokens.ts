import type { Sql } from "postgres";

/** The connected X account's creds for one agent instance (OAuth 1.0a or 2). */
export interface XApiTokenRow {
  /** 'oauth1a' (HMAC-SHA1 signed) | 'oauth2' (Bearer + refresh). */
  authKind: string;
  accessToken: string;
  refreshToken: string | null;
  /** epoch ms, or null when unknown / n/a (oauth1a doesn't expire). */
  expiresAt: number | null;
  xUserId: string | null;
  xHandle: string | null;
  // OAuth 1.0a fields (null on the oauth2 path).
  consumerKey: string | null;
  consumerSecret: string | null;
  accessTokenSecret: string | null;
}

export async function readXApiTokens(sql: Sql, agentInstanceId: string): Promise<XApiTokenRow | null> {
  const rows = await sql<
    Array<{
      auth_kind: string | null;
      access_token: string;
      refresh_token: string | null;
      access_token_expires_at: string | null;
      x_user_id: string | null;
      x_handle: string | null;
      consumer_key: string | null;
      consumer_secret: string | null;
      access_token_secret: string | null;
    }>
  >`
    select auth_kind, access_token, refresh_token, access_token_expires_at, x_user_id, x_handle,
           consumer_key, consumer_secret, access_token_secret
    from noelle.x_api_tokens
    where agent_instance_id = ${agentInstanceId}
    limit 1
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    authKind: r.auth_kind ?? "oauth2",
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: r.access_token_expires_at ? new Date(r.access_token_expires_at).getTime() : null,
    xUserId: r.x_user_id,
    xHandle: r.x_handle,
    consumerKey: r.consumer_key,
    consumerSecret: r.consumer_secret,
    accessTokenSecret: r.access_token_secret,
  };
}

/** Persist rotated OAuth2 tokens after a refresh (the client's onTokensRefreshed callback). */
export async function saveRefreshedXApiTokens(
  sql: Sql,
  agentInstanceId: string,
  t: { accessToken: string; refreshToken?: string; expiresAt?: number },
): Promise<void> {
  await sql`
    update noelle.x_api_tokens
       set access_token = ${t.accessToken},
           refresh_token = coalesce(${t.refreshToken ?? null}, refresh_token),
           access_token_expires_at = coalesce(
             ${t.expiresAt ? new Date(t.expiresAt).toISOString() : null},
             access_token_expires_at
           )
     where agent_instance_id = ${agentInstanceId}
  `;
}

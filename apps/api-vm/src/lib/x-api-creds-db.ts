import type { Sql } from "postgres";

export interface XApiCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  handle?: string | undefined;
}

export class XApiCredentialsScopeError extends Error {
  constructor() {
    super("X API credentials no longer have the authorized owner.");
    this.name = "XApiCredentialsScopeError";
  }
}

/** Credential storage and its posting switch commit together under the current owner. */
export async function mutateXApiCredentials(
  sql: Sql,
  scope: { orgId: string; instanceId: string },
  credentials: XApiCredentials | null,
): Promise<void> {
  await sql.begin(async raw => {
    const tx = raw as unknown as Sql;
    await tx`set local lock_timeout='5s'`;
    await tx`set local statement_timeout='10s'`;
    await tx`set local idle_in_transaction_session_timeout='20s'`;
    const [instance] = await tx`select id from noelle.agent_instances
      where id=${scope.instanceId} and org_id=${scope.orgId} and role='x_intern'
      for no key update`;
    if (!instance) throw new XApiCredentialsScopeError();

    // Parent first matches publishing authority; refreshers lock only the token.
    const [token] = await tx<{ org_id: string }[]>`select org_id from noelle.x_api_tokens
      where agent_instance_id=${scope.instanceId} for update`;
    if (token && token.org_id.toLowerCase() !== scope.orgId.toLowerCase())
      throw new XApiCredentialsScopeError();

    if (credentials) {
      const xUserId = credentials.accessToken.includes("-")
        ? credentials.accessToken.split("-")[0]!
        : null;
      const inserted = await tx`insert into noelle.x_api_tokens
        (org_id,agent_instance_id,auth_kind,access_token,consumer_key,consumer_secret,access_token_secret,x_user_id,x_handle)
        values (${scope.orgId},${scope.instanceId},'oauth1a',${credentials.accessToken},${credentials.consumerKey},
          ${credentials.consumerSecret},${credentials.accessTokenSecret},${xUserId},${credentials.handle ?? null})
        on conflict (agent_instance_id) do update set
          auth_kind='oauth1a',access_token=excluded.access_token,consumer_key=excluded.consumer_key,
          consumer_secret=excluded.consumer_secret,access_token_secret=excluded.access_token_secret,
          x_user_id=excluded.x_user_id,x_handle=coalesce(excluded.x_handle,noelle.x_api_tokens.x_handle),updated_at=now()
        where noelle.x_api_tokens.org_id=${scope.orgId}
        returning id`;
      if (inserted.length !== 1) throw new XApiCredentialsScopeError();
    } else {
      await tx`delete from noelle.x_api_tokens
        where agent_instance_id=${scope.instanceId} and org_id=${scope.orgId}`;
    }
    await tx`update noelle.agent_instances set x_api_write_enabled=${credentials !== null}
      where id=${scope.instanceId} and org_id=${scope.orgId} and role='x_intern'`;
  });
}

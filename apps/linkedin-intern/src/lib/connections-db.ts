import type { Sql } from "postgres";
import { clearApifyTokenExhausted as clearFlags } from "@noelle/runtime/apify-pool-db";

export {
  getActiveConnection,
  listApifyTokens,
  listApifyTokensForHealthSweep,
  pruneInvalidApifyTokens,
  markApifyTokenInvalid,
  DEFAULT_RETRY_COOLDOWN_DAYS,
  markApifyTokenExhausted,
  type ActiveConnection,
  type ApifyTokenRow as ApifyTokenCandidate,
  type SweepCandidate,
  type MarkExhaustedOpts,
} from "@noelle/runtime/apify-pool-db";

/** Preserve the no-op timestamp for a credential with no exhausted/invalid flags. */
export async function clearApifyTokenExhausted(sql: Sql, credentialId: string): Promise<void> {
  await clearFlags(sql, credentialId, { onlyIfFlagged: true });
}

export const clearApifyTokenInvalid = clearApifyTokenExhausted;

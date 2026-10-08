import type { Sql } from "postgres";
import { ContentMediaWriteError } from "./content-media-binding.js";

/** One asset's upload, relink and cleanup cannot overlap. Busy work rejects without waiting. */
export async function lockMediaMutation(sql: Sql, id: string): Promise<void> {
  const [row] = await sql<{ locked: boolean }[]>`select
    pg_try_advisory_xact_lock(hashtextextended('content-media:' || ${id},0)) as locked`;
  if (!row?.locked) throw new ContentMediaWriteError("not_ready");
}

import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { decideCronAuth } from "@/lib/cron-auth";

/**
 * 5-min Vercel cron — docs/architecture.md § Flow D (Cost rollup).
 *
 * Aggregates `noelle.llm_calls` by (org_id, month, bucket) and upserts the
 * result into `noelle.org_spend_month`. The dashboard's `/spend` page reads
 * `org_spend_month` exclusively, so this is the only writer.
 *
 * We rewrite the current + previous month every tick. Cheap (indexed on
 * `(org_id, started_at)`, low row count for the alpha) and idempotent — no
 * cursor state to drift.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const decision = decideCronAuth({
    authHeader: req.headers.get("Authorization"),
    cronSecret: process.env.CRON_SECRET,
    isProduction: process.env.NODE_ENV === "production",
    allowUnauthenticated: process.env.CRON_ALLOW_UNAUTHENTICATED === "true",
  });
  if (!decision.ok) {
    if (decision.code === "cron_secret_unset") {
      // Iron rule: never fail silently. A prod deploy missing CRON_SECRET would
      // 401 every 5 min forever and let org_spend_month / the /spend page drift
      // stale with zero signal, so surface it loudly.
      console.error(
        "[cron/sync-spend] refused: CRON_SECRET unset in production — spend rollup halted; set CRON_SECRET in Vercel env",
      );
    }
    return NextResponse.json(
      { error: { code: decision.code, message: "Cron auth failed" } },
      { status: decision.status },
    );
  }

  const startedAt = Date.now();

  // Upsert the rollup. Window covers current + previous month so a
  // late-arriving llm_calls row near a month boundary still gets included.
  // `excluded.cents` is the freshly aggregated value; we overwrite blindly
  // because the source-of-truth is always the SUM at query time.
  const result = await sql<Array<{ org_id: string; month: string; bucket: string; cents: number }>>`
    insert into noelle.org_spend_month (org_id, month, bucket, cents, updated_at)
    select
      org_id,
      date_trunc('month', started_at)::date as month,
      bucket,
      sum(cents)::bigint                    as cents,
      now()                                 as updated_at
    from noelle.llm_calls
    where started_at >= date_trunc('month', now() - interval '1 month')
    group by 1, 2, 3
    on conflict (org_id, month, bucket) do update
      set cents      = excluded.cents,
          updated_at = excluded.updated_at
    returning org_id, month::text, bucket, cents
  `;

  return NextResponse.json({
    ok: true,
    rowsUpserted: result.length,
    durationMs: Date.now() - startedAt,
    ranAt: new Date().toISOString(),
  });
}

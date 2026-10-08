import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getUserFromCookies } from "@/lib/auth-cookie";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The first organization of the verified session or configured local operator. */
export async function GET(_request: Request) {
  const user = await getUserFromCookies();
  if (!user) return NextResponse.json({ slug: null }, { headers: { "Cache-Control": "no-store" } });
  try {
    const rows = await sql<{ slug: string }[]>`
      select o.slug
      from noelle.organizations o
      join noelle.org_members m on m.org_id = o.id
      where m.user_id = ${user.id}
      order by o.created_at asc
      limit 1
    `;
    return NextResponse.json(
      { slug: rows[0]?.slug ?? null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { slug: null, error: "organization_lookup_failed" },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

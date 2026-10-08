/** GET one authorized metadata page from the organization's current vault source. */

import { NextResponse } from "next/server";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import { listVaultFilesForOrg, VaultListingError } from "@/lib/vault";

export const runtime = "nodejs";

const QuerySchema = z.object({
  orgId: z.string().uuid(),
  pageToken: z.string().optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).optional(),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({ orgId: url.searchParams.get("orgId"),
    pageToken: url.searchParams.get("pageToken") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_request", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const { orgId, pageToken, limit } = parsed.data;
    const page = await listVaultFilesForOrg(orgId, {
      ...(pageToken === undefined ? {} : { pageToken }), ...(limit === undefined ? {} : { limit }),
    });
    return NextResponse.json(page, { status: page.status === "unavailable" ? 503 : 200 });
  } catch (err) {
    if (err instanceof OrgMembershipError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (err instanceof VaultListingError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.code === "unauthorized" ? 401 : 400 });
    }
    throw err;
  }

}

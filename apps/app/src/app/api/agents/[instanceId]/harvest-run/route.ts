import { NextResponse } from "next/server";
import { OrgMembershipError } from "@noelle/runtime";
import { getVideoHarvestStatus } from "@/lib/video-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/agents/[instanceId]/harvest-run
 *
 * Latest harvest run status + live per-lane summary for Nova's harvest console
 * (polled ~3s while a run is in flight). getVideoHarvestStatus fetches the
 * instance first via getAgentInstance → assertOrgMember (the IDOR guard), so an
 * out-of-org caller gets 403 / an unknown instance 404.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
): Promise<NextResponse> {
  const { instanceId } = await ctx.params;
  try {
    const status = await getVideoHarvestStatus(instanceId);
    if (!status) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof OrgMembershipError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw err;
  }
}

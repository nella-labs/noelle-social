import { NextResponse } from "next/server";
import { OrgMembershipError } from "@noelle/runtime";
import {
  getCurrentUser,
  getOrgBySlug,
  countPendingApprovalsAcrossAgents,
} from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Refresh the actionable backlog after session and workspace membership checks. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgSlug: string }> },
) {
  const { orgSlug } = await params;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "sign in required" } },
      { status: 401 },
    );
  }

  try {
    const org = await getOrgBySlug(orgSlug);
    if (!org) {
      return NextResponse.json(
        { error: { code: "not_found", message: "org not found" } },
        { status: 404 },
      );
    }
    const pendingApprovals = await countPendingApprovalsAcrossAgents(org.id);
    return NextResponse.json(
      { pendingApprovals },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (err) {
    if (err instanceof OrgMembershipError) {
      return NextResponse.json(
        { error: { code: "forbidden", message: "not a member of this org" } },
        { status: 403 },
      );
    }
    throw err;
  }
}

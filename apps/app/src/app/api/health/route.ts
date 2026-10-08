import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "noelle-app",
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    uptimeSec: Math.floor(process.uptime()),
  });
}

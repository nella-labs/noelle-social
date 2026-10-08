import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// Edge runtime: sb.auth.exchangeCodeForSession() deadlocks on Vercel
// Node Serverless (same pattern as 27e3cb4 / 659311d). Edge is fine —
// no DB call here.
export const runtime = "edge";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const errorParam = searchParams.get("error");

  if (errorParam || !code) {
    return NextResponse.redirect(`${origin}/?error=auth_failed`);
  }

  const sb = await createSupabaseServerClient();
  const { error } = await sb.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/?error=auth_failed`);
  }

  // Hand off to /auth/gate (Node runtime) for the email-allowlist check
  // before the user is allowed past the front door. /auth/gate sets the
  // signed `noelle_email_verified` cookie that middleware looks for.
  return NextResponse.redirect(`${origin}/auth/gate`);
}

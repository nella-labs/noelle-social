import { redirect } from "next/navigation";
import { LoginScreen } from "@/components/auth/LoginScreen";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isLocalAuth, localOrgSlug } from "@/lib/local-auth";

export const dynamic = "force-dynamic";
// Use Edge runtime: the Node.js Serverless variant deadlocks on
// `sb.auth.getUser()` (the same call returns in <0.4s from middleware,
// which already runs on Edge). Aligning the page runtime fixes the hang.
export const runtime = "edge";

interface LoginPageProps {
  searchParams: Promise<{ error?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  // Self-host: no login screen — there is exactly one operator. Go straight to
  // the configured workspace, skipping the (Supabase-coupled, client-side) onboarding
  // flow and without ever constructing the Supabase client.
  if (isLocalAuth()) {
    redirect(`/app/${localOrgSlug()}`);
  }

  const sb = await createSupabaseServerClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (user) {
    redirect("/onboarding");
  }

  const { error } = await searchParams;
  const errorMessage = errorCopy(error);

  return <LoginScreen errorMessage={errorMessage} />;
}

function errorCopy(error: string | undefined): string | null {
  switch (error) {
    case "auth_failed":
      return "We couldn't finish signing you in. Try again.";
    case "not_invited":
      return "This account does not have access to this hosted workspace. See About Noelle for self-hosting.";
    case "gate_unavailable":
      return "Sign-in is temporarily unavailable. Try again in a moment.";
    default:
      return null;
  }
}

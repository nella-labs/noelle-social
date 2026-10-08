import { redirect } from "next/navigation";
import { getUserFromCookies } from "@/lib/auth-cookie";
import { isLocalAuth } from "@/lib/local-auth";
import { OnboardingClient } from "./OnboardingClient";

export default async function OnboardingPage() {
  if (!await getUserFromCookies()) redirect("/");
  return <OnboardingClient local={isLocalAuth()} />;
}

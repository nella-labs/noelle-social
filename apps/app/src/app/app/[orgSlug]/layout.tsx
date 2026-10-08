import { notFound, redirect } from "next/navigation";
import { NavRail } from "@/components/nav/NavRail";
import { MobileNav } from "@/components/nav/MobileNav";
import { OrgCrumbs } from "@/components/nav/OrgCrumbs";
import { CrumbsProvider } from "@/components/nav/crumbs-context";
import {
  countPendingApprovalsAcrossAgents,
  getCurrentUser,
  getOrgBySlug,
} from "@/lib/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isLocalAuth } from "@/lib/local-auth";

interface LayoutProps { children: React.ReactNode; params: Promise<{ orgSlug: string }>; }

async function logoutAction() {
  "use server";
  // Self-host single-user: no Supabase session to sign out of. Send to "/",
  // which immediately redirects back to /onboarding under local auth.
  if (isLocalAuth()) {
    redirect("/");
  }
  const sb = await createSupabaseServerClient();
  await sb.auth.signOut();
  redirect("/");
}

export default async function DashboardLayout({ children, params }: LayoutProps) {
  const { orgSlug } = await params;
  const [user, org] = await Promise.all([getCurrentUser(), getOrgBySlug(orgSlug)]);
  if (!user) redirect(`/?next=/app/${orgSlug}`);
  if (!org) notFound();

  const pendingCount = await countPendingApprovalsAcrossAgents(org.id).catch(() => 0);

  const displayName = user.user_metadata?.full_name || user.email?.split("@")[0] || "You";
  const handle = user.email ? `@${user.email.split("@")[0]}` : "@you";
  return (
    <div className="app">
      <NavRail
        orgSlug={orgSlug}
        org={{ name: org.name }}
        user={{ name: displayName, handle, monogram: displayName.slice(0, 1).toUpperCase() }}
        pendingApprovals={pendingCount}
        logoutAction={logoutAction}
      />
      <div className="main">
        <MobileNav
          orgSlug={orgSlug}
          org={{ name: org.name }}
          user={{ name: displayName, handle, monogram: displayName.slice(0, 1).toUpperCase() }}
          pendingApprovals={pendingCount}
          logoutAction={logoutAction}
        />
        <CrumbsProvider>
          <OrgCrumbs orgSlug={orgSlug} orgName={org.name} />
          <div className="main-content">
            <div className="main-scroll">
              {children}
            </div>
          </div>
        </CrumbsProvider>
      </div>
    </div>
  );
}

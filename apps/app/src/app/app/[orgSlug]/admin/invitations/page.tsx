import { AdminGate } from "@/components/admin/AdminGate";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminSection } from "@/components/admin/AdminSection";
import { AdminTabs } from "@/components/admin/AdminTabs";
import { Kpi } from "@/components/admin/Kpi";
import { InvitationsManager } from "@/components/admin/InvitationsManager";
import { checkAdmin, checkPrimaryAdmin } from "@/lib/admin-gate";
import { listInvitations } from "@/lib/invitations";
import { listmonkConfigured } from "@/lib/listmonk";

interface PageProps {
  params: Promise<{ orgSlug: string }>;
}

export default async function AdminInvitationsPage({ params }: PageProps) {
  const { orgSlug } = await params;
  const { isAdmin } = await checkAdmin();
  if (!isAdmin) {
    return (
      <>
        <AdminPageHeader
          eyebrow="Operations · Invites"
          title={<>Invites.</>}
          sub="Generate and track alpha invitations."
        />
        <AdminGate />
      </>
    );
  }

  const { isPrimaryAdmin } = await checkPrimaryAdmin();
  const invitations = await listInvitations();

  const pending = invitations.filter((i) => i.status === "pending").length;
  const redeemed = invitations.filter((i) => i.status === "redeemed").length;
  const revoked = invitations.filter((i) => i.status === "revoked").length;

  return (
    <>
      <AdminPageHeader
        eyebrow="Operations · Invites"
        title={
          <>
            <em>Invites.</em>
          </>
        }
        sub="Email-bound invites send via Listmonk + SES and seed the sign-in allowlist. Loose codes are shareable and revocable. Generating and revoking is owner-only."
      />

      <AdminTabs active="invitations" orgSlug={orgSlug} />

      <div className="grid-4" style={{ marginBottom: 24 }}>
        <Kpi label="Total" value={invitations.length} sub="all time" />
        <Kpi label="Pending" value={pending} sub="not yet redeemed" tone={pending > 0 ? "ok" : undefined} />
        <Kpi label="Redeemed" value={redeemed} sub="became an org" />
        <Kpi label="Revoked" value={revoked} sub="manually killed" />
      </div>

      <AdminSection
        title="Invitations"
        sub="Newest first. Codes can be copied; pending invites can be revoked."
      >
        <InvitationsManager
          invitations={invitations}
          canManage={isPrimaryAdmin}
          listmonkConfigured={listmonkConfigured()}
        />
      </AdminSection>
    </>
  );
}

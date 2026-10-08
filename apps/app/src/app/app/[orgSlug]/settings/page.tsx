import { notFound, redirect } from "next/navigation";
import { AppLink } from "@/components/nav/AppLink";
import { PageHeader } from "@/components/nav/PageHeader";
import { ChannelSettings } from "@/components/growth/ChannelSettings";
import { WorkspacePanel } from "@/components/growth/WorkspacePanel";
import styles from "@/components/growth/settings.module.css";
import { sql } from "@/lib/db";
import { getCurrentUser, getOrgBySlug, listAgentInstancesForOrg } from "@/lib/queries";
import { renameOrg } from "./actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ params, searchParams }: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ orgSlug }, { tab }] = await Promise.all([params, searchParams]);
  const [user, org] = await Promise.all([getCurrentUser(), getOrgBySlug(orgSlug)]);
  if (!user) redirect("/");
  if (!org) notFound();
  const active = tab === "voice" || tab === "workspace" ? tab : "channels";
  const instances = active !== "workspace" ? await listAgentInstancesForOrg(org.id) : [];
  const membership = active === "workspace" ? await sql<{ role: string }[]>`
    select role from noelle.org_members where org_id=${org.id} and user_id=${user.id} limit 1
  ` : [];
  const isOwner = membership[0]?.role === "owner";
  const base = `/app/${orgSlug}`;

  return <div className={styles.workspace}>
    <PageHeader eyebrow="Workspace preferences" title="Settings" sub="Set up your channels, shape your voice, and keep your workspace running." />
    <nav className={styles.tabs} aria-label="Settings sections">
      {[{ id: "channels", label: "Channels" }, { id: "voice", label: "Voice" }, { id: "workspace", label: "Workspace" }].map((item) => (
        <AppLink key={item.id} href={`${base}/settings?tab=${item.id}`} className={active === item.id ? styles.active : undefined} aria-current={active === item.id ? "page" : undefined}>{item.label}</AppLink>
      ))}
    </nav>
    {active === "channels" && <ChannelSettings orgSlug={orgSlug} instances={instances} />}
    {active === "voice" && <WorkspacePanel title="Write like yourself" meta="Give your drafts a clear voice and useful context.">
      <p className={styles.description}>Add writing samples and the details that make your work yours. Your voice library is optional; you can start with a few answers and improve it over time.</p>
      <div className={styles.actions}>
        <AppLink href={`${base}/onboarding/vault`} className="btn btn-primary btn-sm">Set up your voice</AppLink>
        <AppLink href={`${base}/vault`} className="btn btn-sm">Open voice library</AppLink>
        {instances.filter((instance) => instance.role === "linkedin_intern").map((instance) => <AppLink key={instance.id} href={`${base}/agents/${instance.id}/feeder`} className="btn btn-sm">Writing styles</AppLink>)}
      </div>
    </WorkspacePanel>}
    {active === "workspace" && <WorkspacePanel title="Workspace details">
      <form className={styles.form} action={async (formData: FormData) => {
        "use server";
        await renameOrg({ orgId: org.id, orgSlug: org.slug, name: String(formData.get("name") ?? "") });
      }}>
        <label>Workspace name<input name="name" defaultValue={org.name} disabled={!isOwner} minLength={2} maxLength={80} required /></label>
        <button className="btn btn-primary" type="submit" disabled={!isOwner}>Save name</button>
      </form>
      <div className={styles.details}><span>Workspace address<strong>{org.slug}</strong></span><span>Created<strong>{new Date(org.created_at).toISOString().slice(0,10)}</strong></span><span>Your access<strong>{isOwner ? "Owner" : "Member"}</strong></span></div>
    </WorkspacePanel>}
    <WorkspacePanel title="Connected services and usage" meta="Manage the services that discover posts and power your writing.">
      <div className={styles.utilityLinks}>
        <AppLink href={`${base}/connections`} className="btn btn-sm">Connections</AppLink>
        <AppLink href={`${base}/connections?tab=spend`} className="btn btn-sm">Usage and spend</AppLink>
        <AppLink href={`${base}/system`} className="btn btn-sm btn-ghost">System status</AppLink>
      </div>
    </WorkspacePanel>
  </div>;
}

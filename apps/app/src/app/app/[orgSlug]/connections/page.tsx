import { notFound } from "next/navigation";
import { Cable, ChartNoAxesCombined } from "lucide-react";
import styles from "./connections.module.css";
import { AppLink } from "@/components/nav/AppLink";
import { PageHeader } from "@/components/nav/PageHeader";
import { getOrgBySlug } from "@/lib/queries";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { SpendPanel } from "./SpendPanel";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ tab?: string; range?: string }>;
}

export default async function ConnectionsPage({ params, searchParams }: PageProps) {
  const [{ orgSlug }, { tab, range }] = await Promise.all([params, searchParams]);
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();
  const showSpend = tab === "spend";
  const base = `/app/${orgSlug}/connections`;

  return (
    <div className={styles.workspace}>
      <PageHeader
        eyebrow={org.name}
        title={<>Connections <em>&amp; spend.</em></>}
        sub="Manage your connected services and track what your agents spend."
      />
      <nav className={styles.navigation} aria-label="Connections and spend">
        {[
          { label: "Connections", href: base, active: !showSpend },
          { label: "Spend", href: `${base}?tab=spend`, active: showSpend },
        ].map(({ label, href, active }) => (
          <AppLink
            key={label}
            href={href}
            className={active ? styles.active : undefined}
            aria-current={active ? "page" : undefined}
          >
            {label === "Connections" ? <Cable size={14} aria-hidden /> : <ChartNoAxesCombined size={14} aria-hidden />}{label}
          </AppLink>
        ))}
      </nav>
      {showSpend
        ? <SpendPanel orgId={org.id} orgSlug={orgSlug} rangeParam={range} />
        : <ConnectionsPanel orgId={org.id} orgSlug={orgSlug} />}
    </div>
  );
}

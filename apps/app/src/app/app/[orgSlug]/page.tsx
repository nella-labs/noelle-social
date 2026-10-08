import { notFound } from "next/navigation";
import { GrowthOverview } from "@/components/growth/GrowthOverview";
import { loadGrowthOverview } from "@/lib/growth-overview";
import { getOrgBySlug } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function WorkspaceHome({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();
  const data = await loadGrowthOverview(org.id);
  return <GrowthOverview data={data} orgSlug={orgSlug} />;
}

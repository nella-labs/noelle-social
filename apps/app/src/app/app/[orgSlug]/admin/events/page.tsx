import { redirect } from "next/navigation";

export default async function LegacyOperationsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  redirect(`/app/${orgSlug}/admin/infrastructure`);
}

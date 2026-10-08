import { redirect } from "next/navigation";

export default async function LegacyWorkspacePage({ params }: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  redirect(`/app/${orgSlug}`);
}

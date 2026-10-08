import { redirect } from "next/navigation";

// The video studio now lives INSIDE the Content workspace as the "Video" lane
// (?platform=video) — not a separate page. Redirect any old /studio links there.
export default async function StudioRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  redirect(`/app/${orgSlug}/content?platform=video`);
}

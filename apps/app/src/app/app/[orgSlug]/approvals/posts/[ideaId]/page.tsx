import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ orgSlug: string; ideaId: string }>;
}

/** Post detail moved under the Content workspace. Redirect to `/content/:id`. */
export default async function PostDetailRedirect({ params }: PageProps) {
  const { orgSlug, ideaId } = await params;
  redirect(`/app/${orgSlug}/content/${ideaId}`);
}

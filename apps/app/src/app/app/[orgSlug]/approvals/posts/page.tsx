import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ board?: string }>;
}

/**
 * The Posts lane has moved to the top-level cross-platform Content workspace
 * (`/content`). This route now redirects, preserving the board (the old "week"
 * board folded into "overview") and landing on the LinkedIn view to match the
 * lane's prior scope. Kept for one release so existing links/bookmarks survive.
 */
export default async function PostsApprovalsRedirect({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const { board } = await searchParams;
  const mapped = board === "drafts" ? "drafts" : board === "week" ? "overview" : "ideas";
  const qs = mapped === "ideas" ? "" : `&board=${mapped}`;
  redirect(`/app/${orgSlug}/content?platform=linkedin${qs}`);
}

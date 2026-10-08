import { notFound } from "next/navigation";
import { AppLink as Link } from "@/components/nav/AppLink";
import { PageHeader } from "@/components/nav/PageHeader";
import { AutoRefresh } from "@/app/app/[orgSlug]/approvals/AutoRefresh";
import { DrafterChat } from "@/components/posts/DrafterChat";
import { StylePicker } from "@/components/posts/StylePicker";
import { PostSetColumns } from "@/components/posts/PostSetColumns";
import { getOrgBySlug, listAgentInstancesForOrg } from "@/lib/queries";
import { getPostThread } from "@/lib/posts-queries";
import { listFeederSources } from "@/lib/feeder-queries";

interface PageProps {
  params: Promise<{ orgSlug: string; ideaId: string }>;
}

const PLATFORM_LABEL: Record<string, string> = {
  linkedin: "LinkedIn",
  x: "X",
  reddit: "Reddit",
};

/**
 * Post-set detail / refine. One idea fans out into side-by-side platform columns
 * (X + LinkedIn), each with its own versions. The drafter chat below tailors the
 * whole set (framing, anecdote, things to avoid) and regenerates. Pin a note to
 * make it a standing rule. /approvals/posts/:id redirects here.
 */
export default async function PostDetailPage({ params }: PageProps) {
  const { orgSlug, ideaId } = await params;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();

  const thread = await getPostThread(ideaId);
  if (!thread) notFound();

  const { idea, drafts, media, notes } = thread;

  // Style picker (the LinkedIn post drafter's "write in this exact person's style"
  // lever). Resolve the org's LinkedIn intern + its ingested style sources; only
  // render the picker when there are sources to choose from. The pin is
  // instance-level (account_feeder_config.pinnedStyleHandle) so it also drives the
  // reply lane — same value the drafter chat's "follow X's style" sets.
  const linkedinInstance = (await listAgentInstancesForOrg(org.id)).find(
    (i) => i.role === "linkedin_intern",
  );
  const styleSources = linkedinInstance ? await listFeederSources(linkedinInstance.id) : [];
  const pinnedStyleHandle =
    (linkedinInstance?.account_feeder_config as { pinnedStyleHandle?: string } | null | undefined)
      ?.pinnedStyleHandle ?? null;

  const regenerating = idea.status === "approved" || idea.status === "drafting";
  const targets = idea.target_platforms?.length ? idea.target_platforms : [idea.platform];
  const eyebrow = targets.map((p) => PLATFORM_LABEL[p] ?? p).join(" + ");
  const backHref = `/app/${orgSlug}/content?board=drafts`;

  return (
    <>
      <AutoRefresh intervalMs={15000} />
      <PageHeader
        eyebrow={eyebrow}
        title={<>Refine <em>post set</em></>}
        sub={idea.hook}
        right={
          <Link href={backHref} className="btn btn-sm">
            ← All posts
          </Link>
        }
      />

      <div className="post-detail-grid">
        <div className="post-detail-main">
          {regenerating && drafts.length > 0 && (
            <div className="clay-flat regen-banner mono">Regenerating with your latest guidance…</div>
          )}
          <PostSetColumns orgSlug={orgSlug} idea={idea} drafts={drafts} media={media} />
        </div>
        <aside className="post-detail-side">
          {linkedinInstance && styleSources.length > 0 && (
            <StylePicker
              orgSlug={orgSlug}
              instanceId={linkedinInstance.id}
              sources={styleSources.map((s) => ({ handle: s.handle, displayName: s.display_name }))}
              current={pinnedStyleHandle}
            />
          )}
          <DrafterChat orgSlug={orgSlug} ideaId={ideaId} notes={notes} />
        </aside>
      </div>
    </>
  );
}

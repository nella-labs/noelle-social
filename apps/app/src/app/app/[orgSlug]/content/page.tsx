import { notFound } from "next/navigation";
import { AgentWorkspaceShell } from "@/components/posts/AgentWorkspaceShell";
import { loadWorkspaceData } from "@/lib/agent-content-data";

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ board?: string; platform?: string; focus?: string }>;
}

export default async function ContentWorkspacePage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const { board, platform, focus } = await searchParams;

  const data = await loadWorkspaceData({
    orgSlug,
    platformParam: platform,
    boardParam: board ?? "drafts",
    focusParam: focus,
  });

  if (data.kind === "not-found") notFound();

  return <AgentWorkspaceShell data={data} />;
}

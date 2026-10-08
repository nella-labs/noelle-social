import { notFound, redirect } from "next/navigation";
import { ChannelWorkspace } from "@/components/growth/ChannelWorkspace";
import { getAgentInstance, getOrgBySlug, listAgentInstancesForOrg } from "@/lib/queries";
import { AGENT_UUID_RE, agentHref, matchAgentBySlug } from "@/lib/agent-route";
import { SOCIAL_CHANNELS, channelForRole } from "@/lib/social-channels";
import { loadChannelWorkspace } from "@/lib/channel-workspace";

export const dynamic = "force-dynamic";

export default async function ChannelPage({ params }: {
  params: Promise<{ orgSlug: string; instanceId: string }>;
}) {
  const { orgSlug, instanceId } = await params;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();
  const instances = AGENT_UUID_RE.test(instanceId) ? [] : await listAgentInstancesForOrg(org.id);
  const instance = AGENT_UUID_RE.test(instanceId)
    ? await getAgentInstance(instanceId)
    : matchAgentBySlug(instances, instanceId) ?? instances.find((row) => SOCIAL_CHANNELS.find((channel) => channel.setupSlug === instanceId)?.role === row.role);
  if (!instance) {
    if (SOCIAL_CHANNELS.some((channel) => channel.setupSlug === instanceId)) redirect(`/app/${orgSlug}/settings?tab=channels`);
    notFound();
  }
  if (instance.org_id !== org.id || !channelForRole(instance.role) || instance.status === "retired") notFound();
  if (SOCIAL_CHANNELS.some((channel) => channel.setupSlug === instanceId)) redirect(agentHref(orgSlug, instance));
  const data = await loadChannelWorkspace(instance);
  return <ChannelWorkspace orgSlug={orgSlug} routeSegment={instanceId} instance={instance} data={data} />;
}

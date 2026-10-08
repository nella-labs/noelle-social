import { resolveLaneConfig } from "@noelle/contracts";
import { resolveObjective, hasCustomObjective } from "@noelle/runtime";
import { AppLink } from "@/components/nav/AppLink";
import { PageHeader } from "@/components/nav/PageHeader";
import { SetCrumb } from "@/components/nav/SetCrumb";
import { AgentChat } from "@/components/agent-panels/AgentChat";
import { VegaSendQueuePanel } from "@/components/constellation/VegaSendQueuePanel";
import { LyraLanesCard } from "@/components/posts/LyraLanesCard";
import { ObjectiveCard } from "@/app/app/[orgSlug]/agents/[instanceId]/ObjectiveCard";
import { PipelinePanel } from "@/app/app/[orgSlug]/agents/[instanceId]/PipelinePanel";
import { StatusToggleButton } from "@/app/app/[orgSlug]/agents/[instanceId]/StatusToggleButton";
import { ReplySendToggle } from "@/app/app/[orgSlug]/agents/[instanceId]/ReplySendToggle";
import { ActuatorPowerToggle } from "@/app/app/[orgSlug]/agents/[instanceId]/ActuatorPowerToggle";
import { ActivityRow, formatWhen } from "@/app/app/[orgSlug]/agents/[instanceId]/ActivityRow";
import { rowActivityFor } from "@/lib/agent-activity-copy";
import { maintenanceNote, isInternRole } from "@/lib/agent-ui-config";
import { channelForRole } from "@/lib/social-channels";
import { agentHref } from "@/lib/agent-route";
import { formatCents } from "@/lib/utils";
import type { NoelleAgentInstance } from "@/lib/db-types";
import type { ChannelWorkspaceData } from "@/lib/channel-workspace";
import { WorkspacePanel } from "./WorkspacePanel";
import styles from "./settings.module.css";

export function ChannelWorkspace({ orgSlug, routeSegment, instance, data }: {
  orgSlug: string; routeSegment: string; instance: NoelleAgentInstance; data: ChannelWorkspaceData;
}) {
  const channel = channelForRole(instance.role);
  if (!channel || !isInternRole(instance.role)) return null;
  const base = `/app/${orgSlug}`;
  const note = maintenanceNote(instance.role);
  const approvalsHref = channel.stream ? `${base}/approvals?stream=${channel.stream}` : `${base}/content?platform=video`;
  const displayName = instance.display_name ?? channel.label;
  const laneConfig = resolveLaneConfig((instance as { lane_config?: unknown }).lane_config ?? null);
  const configHref = agentHref(orgSlug, instance, "config");
  return <div className={styles.workspace}>
    <SetCrumb segment={routeSegment} label={channel.label} />
    <PageHeader eyebrow="Channel settings" title={channel.label} sub={channel.description} right={<AppLink href={`${base}/settings?tab=channels`} className="btn btn-sm">All channels</AppLink>} />
    <WorkspacePanel title="Channel controls" meta={note ? "Automatic work is paused. Existing scripts and research stay available." : `Current state: ${instance.status}`}>
      <div className={styles.actions}>
        {!note && <StatusToggleButton orgSlug={orgSlug} instanceId={instance.id} status={instance.status} />}
        {(instance.role === "x_intern" || instance.role === "linkedin_intern") && <ReplySendToggle orgSlug={orgSlug} instanceId={instance.id} enabled={instance.reply_send_enabled ?? false} />}
        {instance.role !== "video_intern" && <ActuatorPowerToggle orgSlug={orgSlug} instanceId={instance.id} desired={instance.actuator_desired_state ?? null} lastState={instance.actuator_last_state ?? null} seenAt={instance.actuator_seen_at ?? null} />}
        <AppLink href={approvalsHref} className="btn btn-sm">{channel.stream ? "Review conversations" : "Open scripts"}</AppLink>
      </div>
      <p className={styles.note}>Starting discovery and starting the browser are separate from permission to send replies.</p>
    </WorkspacePanel>
    <nav className={styles.tabs} aria-label={`${channel.label} tools`}>
      {[
        { label: "Targets", href: `${base}/agents/${instance.id}/watchlist` },
        { label: "Preferences", href: configHref },
        { label: "Content", href: `${base}/content?platform=${channel.platform}` },
        ...(instance.role === "linkedin_intern" ? [{ label: "Writing styles", href: `${base}/agents/${instance.id}/feeder` }] : []),
        ...(instance.role !== "video_intern" ? [{ label: "Writing rules", href: `${base}/agents/${instance.id}/patterns` }] : [{ label: "Account performance", href: `${base}/agents/${instance.id}/analytics` }]),
        { label: "Activity", href: agentHref(orgSlug, instance, "activity") },
      ].map((link) => <AppLink key={link.label} href={link.href}>{link.label}</AppLink>)}
    </nav>
    <ObjectiveCard orgSlug={orgSlug} instanceId={instance.id} mission={resolveObjective(instance.objective, channel.description)} isCustom={hasCustomObjective(instance.objective)} agentName={channel.label} targetingHref={`${base}/agents/${instance.id}/watchlist`} />
    {data.pipeline?.status === "ready" && data.pipeline.value ? <PipelinePanel orgSlug={orgSlug} instanceId={instance.id} snapshot={data.pipeline.value} agentRole={instance.role}
      relationshipDms={instance.role === "x_intern" || instance.role === "linkedin_intern" ? { platform: channel.platform as "x" | "linkedin", enabled: laneConfig.dms.relationship_dms_enabled, approvalsHref } : undefined} /> : data.pipeline && <WorkspacePanel title="Discovery and drafting"><p className={styles.description}>Pipeline status is unavailable. Refresh to try again.</p></WorkspacePanel>}
    {instance.role === "linkedin_intern" && data.intelligence?.status === "ready" && data.watched?.status === "ready" && <LyraLanesCard orgSlug={orgSlug} instanceId={instance.id} approvalsHref={approvalsHref} repliesOn={instance.drafter_enabled !== false} dmsOn={instance.dm_autodraft_enabled === true} introDmsOn={instance.linkedin_intro_dm_enabled} postsOn={laneConfig.posts.enabled} watchlistCount={data.watched.value} playbookCount={data.intelligence.value.playbookCount} lastAnalyzedAt={data.intelligence.value.lastAnalyzedAt} />}
    {data.queue?.status === "ready" && data.sent?.status === "ready" && <VegaSendQueuePanel queue={data.queue.value} sent={data.sent.value} autoSendEnabled={instance.auto_send_enabled} configHref={configHref} {...(data.usage ? { replySendEnabled: instance.reply_send_enabled, usage: data.usage.status === "ready" ? data.usage.value : null } : {})} />}
    <WorkspacePanel title={`Writing help · ${channel.label}`}>
      <AgentChat agentId={channel.setupSlug} agentRole={channel.setupSlug} agentName={displayName} instanceId={instance.id} orgSlug={orgSlug} />
    </WorkspacePanel>
    <WorkspacePanel title="Recent activity" action={<AppLink href={agentHref(orgSlug, instance, "activity")} className="btn btn-sm btn-ghost">View all</AppLink>}>
      {data.activity.status === "unavailable" ? <p className={styles.description}>Activity is unavailable.</p> : data.activity.value.length === 0 ? <p className={styles.description}>No recorded activity yet.</p> : data.activity.value.map((event, index) => {
        const copy = rowActivityFor(event);
        return <ActivityRow key={`${event.when}-${index}`} when={formatWhen(event.when)} verb={copy.label} what={copy.detail} cost={event.cents != null ? formatCents(event.cents) : undefined} model={event.model ?? undefined} url={event.url} first={index === 0} />;
      })}
    </WorkspacePanel>
  </div>;
}

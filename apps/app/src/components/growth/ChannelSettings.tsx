import { AppLink } from "@/components/nav/AppLink";
import { SOCIAL_CHANNELS } from "@/lib/social-channels";
import { maintenanceNote } from "@/lib/agent-ui-config";
import type { NoelleAgentInstance } from "@/lib/db-types";
import { agentHref } from "@/lib/agent-route";
import { EnableChannelButton } from "./EnableChannelButton";
import { WorkspacePanel } from "./WorkspacePanel";
import styles from "./settings.module.css";

export function ChannelSettings({ orgSlug, instances }: { orgSlug: string; instances: NoelleAgentInstance[] }) {
  return <div className={styles.channels}>{SOCIAL_CHANNELS.map((channel) => {
    const instance = instances.find((row) => row.role === channel.role);
    const note = maintenanceNote(channel.role);
    return <WorkspacePanel key={channel.role} title={channel.label} meta={instance ? note ? "Manual tools · automatic work paused" : instance.status === "active" ? "Enabled" : instance.status === "paused" ? "Paused" : "Setup pending" : "Not set up"}>
      <p className={styles.description}>{channel.description}</p>
      {instance?.status === "provisioning_alpha" && <EnableChannelButton orgSlug={orgSlug} role={channel.role} label={channel.label} />}
      {instance ? <>
        <div className={styles.actions}>
          <AppLink href={agentHref(orgSlug, instance)} className="btn btn-sm btn-primary">Manage channel</AppLink>
          <AppLink href={`/app/${orgSlug}/agents/${instance.id}/watchlist`} className="btn btn-sm">Edit targets</AppLink>
          <AppLink href={agentHref(orgSlug, instance, "config")} className="btn btn-sm btn-ghost">Preferences</AppLink>
        </div>
        <p className={styles.note}>{channel.platform === "video" ? "Scripts and research are available from Content." : `Reply sending is ${instance.reply_send_enabled ? "on" : "off"}. Manage the channel to review its sending controls.`}</p>
      </> : <EnableChannelButton orgSlug={orgSlug} role={channel.role} label={channel.label} />}
    </WorkspacePanel>;
  })}</div>;
}

import { ArrowUpRight, CalendarDays, Inbox, Lightbulb, PenLine } from "lucide-react";
import { AppLink } from "@/components/nav/AppLink";
import { PageHeader } from "@/components/nav/PageHeader";
import type { GrowthOverviewData } from "@/lib/growth-overview";
import { maintenanceNote } from "@/lib/agent-ui-config";
import { SOCIAL_CHANNELS } from "@/lib/social-channels";
import { GrowthActivity } from "./GrowthActivity";
import { GrowthPerformance } from "./GrowthPerformance";
import { WorkspacePanel } from "./WorkspacePanel";
import styles from "./growth.module.css";

export function GrowthOverview({ data, orgSlug }: { data: GrowthOverviewData; orgSlug: string }) {
  const base = `/app/${orgSlug}`;
  const content = data.content.status === "ready" ? data.content.value : null;
  const tasks = [
    { label: "Review conversations", detail: "Choose the replies worth sending.", count: data.pending.status === "ready" ? data.pending.value : null, href: `${base}/approvals`, icon: Inbox },
    { label: "Finish your drafts", detail: "Edit and prepare original posts.", count: content?.drafts ?? null, href: `${base}/content?board=drafts`, icon: PenLine },
    { label: "Choose your next idea", detail: "Turn a useful thought into a post.", count: content?.ideas ?? null, href: `${base}/content?board=ideas`, icon: Lightbulb },
    { label: "Plan ready posts", detail: "Give finished posts a place in your week.", count: content?.ready ?? null, href: `${base}/content?board=drafts`, icon: CalendarDays },
  ];
  const slots = data.scheduled.status === "ready" ? data.scheduled.value.slice(0, 5) : [];
  return (
    <div className={styles.workspace}>
      <PageHeader eyebrow="Your social workspace" title="Make your next move." sub="Review good conversations, publish useful ideas, and learn from what gets a response." right={<AppLink href={`${base}/content?board=compose&platform=x`} className="btn btn-primary">Create a post <ArrowUpRight size={15} aria-hidden /></AppLink>} />
      <div className={styles.layout}>
        <div className={styles.column}>
          <WorkspacePanel title="Pick up where you left off" meta="Your current reply and original-post queues">
            <div>{tasks.map((task) => <AppLink className={styles.task} key={task.label} href={task.href}>
              <span className={styles.taskIcon}><task.icon size={18} aria-hidden /></span>
              <span className={styles.taskCopy}><strong>{task.label}</strong><small>{task.count === null ? "Queue unavailable. Open to try again." : task.detail}</small></span>
              <span className={styles.taskCount}>{task.count ?? "—"}</span><ArrowUpRight size={16} aria-hidden />
            </AppLink>)}</div>
          </WorkspacePanel>
          <GrowthActivity sent={data.sent} daily={data.daily} />
          <GrowthPerformance performance={data.performance} orgSlug={orgSlug} />
        </div>
        <div className={styles.column}>
          <WorkspacePanel title="Coming up" meta="Next 7 days · UTC" action={<AppLink href={`${base}/content?platform=x&board=schedule`} className="btn btn-sm btn-ghost">Calendar</AppLink>}>
            {data.scheduled.status === "unavailable" ? <p className={styles.empty}>The calendar is unavailable. Open it to try again.</p> : slots.length === 0 ? <p className={styles.empty}>Your week is open. Schedule a post when it is ready.</p> : <div className={styles.schedule}>{slots.map((slot) => (
              <AppLink className={styles.slot} key={slot.id} href={`${base}/content?platform=${encodeURIComponent(slot.platform)}&board=schedule`}>
                <time dateTime={slot.slot_at}><strong>{new Date(slot.slot_at).toLocaleDateString("en-US", { day: "numeric", timeZone: "UTC" })}</strong>{new Date(slot.slot_at).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}</time>
                <div><p>{slot.preview || slot.hook || "Planned post"}</p><small>{SOCIAL_CHANNELS.find((channel) => channel.platform === slot.platform)?.label ?? slot.platform} · {slot.status} · {slot.auto_publish ? "Auto-publish" : "Manual publish"}</small></div>
              </AppLink>
            ))}</div>}
          </WorkspacePanel>
          <WorkspacePanel title="Your channels" action={<AppLink href={`${base}/settings?tab=channels`} className="btn btn-sm btn-ghost">Manage</AppLink>}>
            {data.channels.status === "unavailable" ? <p className={styles.empty}>Channel status is unavailable.</p> : <div className={styles.channelList}>{SOCIAL_CHANNELS.map((channel) => {
              const instance = data.channels.status === "ready" ? data.channels.value.find((row) => row.role === channel.role) : null;
              return <AppLink className={styles.channel} key={channel.role} href={`${base}/settings?tab=channels`}><strong>{channel.label}</strong><span>{instance && maintenanceNote(instance.role) ? "Manual tools" : instance?.status === "active" ? "Enabled" : instance?.status === "paused" ? "Paused" : instance ? "Setup pending" : "Not set up"}</span></AppLink>;
            })}</div>}
          </WorkspacePanel>
          <WorkspacePanel title="Keep it personal" meta="Your voice and the people you follow shape the work.">
            <p className={styles.empty}>Give your writing real context. Set a clear audience, keep your voice current, and follow people you want to learn from.</p>
            <AppLink href={`${base}/contacts`} className="btn btn-sm">Find people <ArrowUpRight size={14} aria-hidden /></AppLink>
          </WorkspacePanel>
        </div>
      </div>
    </div>
  );
}

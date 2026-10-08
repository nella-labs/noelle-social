import { AppLink as Link } from "@/components/nav/AppLink";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/nav/PageHeader";
import { SetCrumb } from "@/components/nav/SetCrumb";
import { rowActivityFor } from "@/lib/agent-activity-copy";
import {
  getAgentInstance,
  getOrgBySlug,
  listAgentInstancesForOrg,
  listRecentActivityForInstance,
} from "@/lib/queries";
import { channelForRole } from "@/lib/social-channels";
import { formatCents } from "@/lib/utils";
import { AGENT_UUID_RE, agentHref, matchAgentBySlug } from "@/lib/agent-route";
import { ActivityRow, formatWhen } from "../ActivityRow";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; instanceId: string }>;
}

/** Full activity feed for one agent — the "Watch more" target from the desk. */
export default async function AgentActivityPage({ params }: PageProps) {
  const { orgSlug, instanceId } = await params;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();

  const instance = AGENT_UUID_RE.test(instanceId)
    ? await getAgentInstance(instanceId)
    : matchAgentBySlug(
        await listAgentInstancesForOrg(org.id).catch(() => []),
        instanceId,
      );
  if (!instance || instance.org_id !== org.id) notFound();

  const displayName =
    instance.display_name ??
    channelForRole(instance.role)?.label ?? "Channel";

  const activity = await listRecentActivityForInstance(instance.id, 200).catch(() => []);

  return (
    <>
      <SetCrumb segment="activity" label="Activity" />
      <PageHeader
        eyebrow={`${displayName} · Activity`}
        title={<>Everything <em>{displayName}</em> has done</>}
        sub="Every draft, decision, and worker run, newest first."
        right={
          <Link href={agentHref(orgSlug, instance)} className="btn btn-sm">
            ← Back to channel
          </Link>
        }
      />

      <section className="card">
        <div style={{ display: "flex", flexDirection: "column" }}>
          {activity.length === 0 ? (
            <div
              style={{
                padding: "24px 0",
                fontSize: 12.5,
                color: "var(--ink-muted)",
                fontFamily: "var(--mono)",
              }}
            >
              No activity yet. Once the workers run, drafts and decisions appear
              here.
            </div>
          ) : (
            activity.map((evt, i) => {
              const copy = rowActivityFor(evt);
              return (
                <ActivityRow
                  key={i}
                  when={formatWhen(evt.when)}
                  verb={copy.label}
                  what={copy.detail}
                  cost={evt.cents != null ? formatCents(evt.cents) : undefined}
                  model={evt.model ?? undefined}
                  url={evt.url}
                  first={i === 0}
                />
              );
            })
          )}
        </div>
      </section>
    </>
  );
}

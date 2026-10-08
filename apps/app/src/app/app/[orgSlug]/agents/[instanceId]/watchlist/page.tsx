import type { ReactNode } from "react";
import { AppLink as Link } from "@/components/nav/AppLink";
import { notFound } from "next/navigation";
import { resolveObjective, hasCustomObjective } from "@noelle/runtime";
import { PageHeader } from "@/components/nav/PageHeader";
import { ClipThumb } from "./ClipThumb";
import { fmtCount } from "@/components/posts/video-reach";
import { PlanLanesButton } from "./PlanLanesButton";
import {
  getOrgBySlug,
  getAgentInstance,
  getWatchlistPeopleForInstance,
  getLinkedInWatchlistPeopleForInstance,
  getRedditWatchlistForInstance,
  listAgentInstancesForOrg,
} from "@/lib/queries";
import { channelForRole } from "@/lib/social-channels";
import { maintenanceNote } from "@/lib/agent-ui-config";
import { AGENT_UUID_RE, agentHref, agentSlug, matchAgentBySlug } from "@/lib/agent-route";
import { sql } from "@/lib/db";
import { ObjectiveCard } from "../ObjectiveCard";
import { WatchlistCard } from "../WatchlistCard";
import { LinkedInWatchlistCard } from "../LinkedInWatchlistCard";
import {
  addWatchlistEntry,
  removeWatchlistEntry,
  addLinkedinKeyword,
  removeLinkedinKeyword,
} from "./actions";
import {
  addRedditWatchlistEntry,
  removeRedditWatchlistEntry,
} from "../reddit-watchlist-actions";
import type { RedditWatchlistRow } from "@/lib/queries";
import {
  addVideoSource,
  removeVideoSource,
  toggleVideoSource,
  addVideoNiche,
  removeVideoNiche,
  requestVideoHarvest,
  saveVideoFeederConfig,
} from "../video-watchlist-actions";
import {
  listVideoWatchlistSources,
  listVideoWatchlistNiches,
  listVideoClips,
  getVideoHarvestStatus,
  getVideoFeederConfig,
  type VideoSourceRow,
  type VideoNicheRow,
  type VideoClipRow,
  type HarvestRunStatus,
} from "@/lib/video-queries";
import type { VideoFeederConfig } from "@noelle/contracts";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; instanceId: string }>;
}

export default async function WatchlistPage({ params }: PageProps) {
  const { orgSlug, instanceId } = await params;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();

  // `instanceId` may be a UUID or a slug ("vega"/"lyra"); resolve to the instance
  // and use its real id for all data + actions.
  const instance = AGENT_UUID_RE.test(instanceId)
    ? await getAgentInstance(instanceId)
    : matchAgentBySlug(
        await listAgentInstancesForOrg(org.id).catch(() => []),
        instanceId,
      );
  if (!instance || instance.org_id !== org.id) notFound();
  // All three interns have a watchlist editor; coordinators do not.
  if (
    instance.role !== "x_intern" &&
    instance.role !== "linkedin_intern" &&
    instance.role !== "reddit_intern" &&
    instance.role !== "video_intern"
  )
    notFound();

  if (instance.role === "linkedin_intern") {
    return (
      <LinkedInWatchlist
        orgSlug={orgSlug}
        instanceId={instance.id}
        objective={instance.objective ?? null}
        displayName={instance.display_name}
      />
    );
  }

  if (instance.role === "reddit_intern") {
    return (
      <RedditWatchlist
        orgSlug={orgSlug}
        instanceId={instance.id}
        objective={instance.objective ?? null}
        displayName={instance.display_name}
      />
    );
  }

  if (instance.role === "video_intern") {
    return (
      <VideoWatchlist
        orgSlug={orgSlug}
        instanceId={instance.id}
        displayName={instance.display_name}
        objective={instance.objective ?? null}
      />
    );
  }

  const rows = await sql<{ id: string; kind: "handle" | "keyword"; value: string; created_at: string }[]>`
    select id, kind, value, created_at
    from noelle.x_watchlist
    where agent_instance_id = ${instance.id}
    order by created_at asc
  `;

  const handles = rows.filter((r) => r.kind === "handle");
  const keywords = rows.filter((r) => r.kind === "keyword");

  const people = await getWatchlistPeopleForInstance(instance.id).catch(() => []);

  const fixture = channelForRole("x_intern")!;
  const displayName = instance.display_name ?? fixture.label;
  const resolvedObjective = resolveObjective(instance.objective ?? null, fixture.description);
  const objectiveIsCustom = hasCustomObjective(instance.objective ?? null);

  return (
    <>
      <PageHeader
        eyebrow="X Growth Intern · Watchlist"
        title={<>Who <em>{displayName}</em> watches & hunts</>}
        sub="Two lists in one place. People are accounts Vega always replies to. Targeting is the handles + keywords the discovery worker sweeps every ~5 min for fresh leads. Empty targeting = no leads."
        right={
          <Link href={agentHref(orgSlug, instance)} className="btn btn-sm">
            ← Back to agent
          </Link>
        }
      />

      <div style={{ marginBottom: 24 }}>
        <ObjectiveCard
          orgSlug={orgSlug}
          instanceId={instance.id}
          mission={resolvedObjective}
          isCustom={objectiveIsCustom}
          agentName={displayName}
        />
      </div>

      {/* People — the primary list: accounts Vega always engages. */}
      <div style={{ marginBottom: 24 }}>
        <WatchlistCard
          orgSlug={orgSlug}
          instanceId={instance.id}
          slug={agentSlug(instance.display_name, instance.id)}
          people={people}
        />
      </div>

      {/* Targeting — the discovery sweep (handles + keywords). */}
      <div className="eyebrow" style={{ marginBottom: 10 }}>
        Targeting · discovery sweep
      </div>
      <div className="stack-phone" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <Column
          title="Handles"
          rows={handles}
          orgSlug={orgSlug}
          instanceId={instance.id}
          kind="handle"
          placeholder="patio11"
        />
        <Column
          title="Keywords"
          rows={keywords}
          orgSlug={orgSlug}
          instanceId={instance.id}
          kind="keyword"
          placeholder="ai agents"
        />
      </div>
    </>
  );
}

/**
 * Lyra's watchlist editor — two lanes. The always-on WATCH lane is the people
 * list (LinkedIn connections she replies to, full parity with Vega's people
 * card); the SEARCH lane is the keyword topics she searches LinkedIn-wide for
 * high-engagement posts (LinkedinKeywordColumn → noelle.linkedin_watchlist).
 * Plus the mission/objective card.

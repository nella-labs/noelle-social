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
 */
async function LinkedInWatchlist({
  orgSlug,
  instanceId,
  objective,
  displayName: displayNameRaw,
}: {
  orgSlug: string;
  instanceId: string;
  objective: string | null;
  displayName: string | null;
}) {
  const fixture = channelForRole("linkedin_intern")!;
  const displayName = displayNameRaw ?? fixture.label;
  const resolvedObjective = resolveObjective(objective, fixture.description);
  const objectiveIsCustom = hasCustomObjective(objective);
  const people = await getLinkedInWatchlistPeopleForInstance(instanceId).catch(() => []);
  const keywordRows = await sql<{ id: string; value: string }[]>`
    select id, value
    from noelle.linkedin_watchlist
    where agent_instance_id = ${instanceId} and kind = 'keyword'
    order by created_at asc
  `.catch(() => [] as { id: string; value: string }[]);

  return (
    <>
      <PageHeader
        eyebrow="LinkedIn Growth Intern · Watchlist"
        title={<>Who <em>{displayName}</em> watches & hunts</>}
        sub="Two lanes. People are the LinkedIn connections Lyra always watches — every new post from one earns a drafted reply. Keywords are topics she searches LinkedIn-wide for high-engagement posts from people outside your network. She drafts replies for approval and never posts (DMs are off by default)."
        right={
          <Link href={`/app/${orgSlug}/agents/${instanceId}`} className="btn btn-sm">
            ← Back to agent
          </Link>
        }
      />

      <div style={{ marginBottom: 24 }}>
        <ObjectiveCard
          orgSlug={orgSlug}
          instanceId={instanceId}
          mission={resolvedObjective}
          isCustom={objectiveIsCustom}
          agentName={displayName}
        />
      </div>

      {/* People — the always-on watch lane: connections Lyra always engages. */}
      <div style={{ marginBottom: 24 }}>
        <LinkedInWatchlistCard orgSlug={orgSlug} instanceId={instanceId} people={people} />
      </div>

      {/* Keywords — the search lane: net-new high-engagement posts by topic. */}
      <div className="eyebrow" style={{ marginBottom: 10 }}>
        Keywords · search lane
      </div>
      <LinkedinKeywordColumn orgSlug={orgSlug} instanceId={instanceId} rows={keywordRows} />
    </>
  );
}

/**
 * Lyra's keyword editor (noelle.linkedin_watchlist). Mirrors Vega's keyword
 * Column but writes to the LinkedIn table via the LinkedIn-gated actions. Topics
 * here drive the SEARCH lane — high-engagement posts from outside the network.
 */
function LinkedinKeywordColumn({
  orgSlug,
  instanceId,
  rows,
}: {
  orgSlug: string;
  instanceId: string;
  rows: { id: string; value: string }[];
}) {
  return (
    <section className="card">
      <div className="card-h">
        <h3>Keywords</h3>
        <span className="tag">{rows.length}</span>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
        Topics Lyra searches LinkedIn-wide for high-engagement posts. Empty = she
        only watches your connections (no search). Set engagement floors under
        Configure agent → Discovery.
      </p>

      <form
        action={async (fd: FormData) => {
          "use server";
          const value = String(fd.get("value") ?? "");
          if (!value) return;
          await addLinkedinKeyword({ orgSlug, instanceId, value });
        }}
        style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}
      >
        <input
          name="value"
          placeholder="building in public"
          className="input"
          style={{ flex: 1 }}
          required
          maxLength={200}
        />
        <button className="btn btn-sm btn-accent" type="submit">Add</button>
      </form>

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {rows.map((r) => (
          <li key={r.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px dashed var(--rule-soft)" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{r.value}</span>
            <form
              action={async () => {
                "use server";
                await removeLinkedinKeyword({ orgSlug, instanceId, rowId: r.id });
              }}
            >
              <button className="btn btn-xs" type="submit">×</button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Column({
  title,
  rows,
  orgSlug,
  instanceId,
  kind,
  placeholder,
}: {
  title: string;
  rows: { id: string; value: string }[];
  orgSlug: string;
  instanceId: string;
  kind: "handle" | "keyword";
  placeholder: string;
}) {
  return (
    <section className="card">
      <div className="card-h">
        <h3>{title}</h3>
        <span className="tag">{rows.length}</span>
      </div>

      <form
        action={async (fd: FormData) => {
          "use server";
          const value = String(fd.get("value") ?? "");
          if (!value) return;
          await addWatchlistEntry({ orgSlug, instanceId, kind, value });
        }}
        style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}
      >
        <input
          name="value"
          placeholder={placeholder}
          className="input"
          style={{ flex: 1 }}
          required
          maxLength={200}
        />
        <button className="btn btn-sm btn-accent" type="submit">Add</button>
      </form>

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {rows.map((r) => (
          <li key={r.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px dashed var(--rule-soft)" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
              {kind === "handle" ? `@${r.value}` : r.value}
            </span>
            <form
              action={async () => {
                "use server";
                await removeWatchlistEntry({ orgSlug, instanceId, rowId: r.id });
              }}
            >
              <button className="btn btn-xs" type="submit">×</button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Orion's watchlist editor — a list of SUBREDDITS (not people/handles). Each
 * subreddit may carry a free-text objective (how to engage) and a min-score
 * floor (skip low-signal threads). Plus the mission/objective card, mirroring
 * the X / LinkedIn watchlist layout.
 */
async function RedditWatchlist({
  orgSlug,
  instanceId,
  objective,
  displayName: displayNameRaw,
}: {
  orgSlug: string;
  instanceId: string;
  objective: string | null;
  displayName: string | null;
}) {
  const fixture = channelForRole("reddit_intern")!;
  const displayName = displayNameRaw ?? fixture.label;
  const resolvedObjective = resolveObjective(objective, fixture.description);
  const objectiveIsCustom = hasCustomObjective(objective);
  const rows = await getRedditWatchlistForInstance(instanceId).catch(
    () => [] as RedditWatchlistRow[],
  );

  return (
    <>
      <PageHeader
        eyebrow="Reddit Growth Intern · Watchlist"
        title={<>Which subreddits <em>{displayName}</em> watches</>}
        sub="The subreddits Orion sweeps for in-ICP threads. Every qualifying thread in one earns a drafted reply. Give a subreddit an objective to steer how Orion engages, and a min score to skip low-signal threads. Approved replies are auto-sent via the Reddit actuator — Skip any you don't want posted."
        right={
          <Link href={`/app/${orgSlug}/agents/${instanceId}`} className="btn btn-sm">
            ← Back to agent
          </Link>
        }
      />

      <div style={{ marginBottom: 24 }}>
        <ObjectiveCard
          orgSlug={orgSlug}
          instanceId={instanceId}
          mission={resolvedObjective}
          isCustom={objectiveIsCustom}
          agentName={displayName}
        />
      </div>

      <SubredditColumn orgSlug={orgSlug} instanceId={instanceId} rows={rows} />
    </>
  );
}

/**
 * Subreddit editor (noelle.reddit_watchlist). One card listing watched
 * subreddits, with an add form (subreddit + optional objective + optional min
 * score). Writes through the reddit_intern-gated server actions.
 */
function SubredditColumn({
  orgSlug,
  instanceId,
  rows,
}: {
  orgSlug: string;
  instanceId: string;
  rows: RedditWatchlistRow[];
}) {
  return (
    <section className="card">
      <div className="card-h">
        <h3>Subreddits</h3>
        <span className="tag">{rows.length}</span>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
        Each subreddit Orion watches. Empty = no targeting (no leads). Set per-run
        engagement floors under Configure agent → Discovery.
      </p>

      <form
        action={async (fd: FormData) => {
          "use server";
          const subreddit = String(fd.get("subreddit") ?? "");
          if (!subreddit) return;
          const objective = String(fd.get("objective") ?? "");
          const minScoreRaw = String(fd.get("minScore") ?? "").trim();
          await addRedditWatchlistEntry({
            orgSlug,
            instanceId,
            subreddit,
            objective,
            ...(minScoreRaw ? { minScore: Number(minScoreRaw) } : {}),
          });
        }}
        style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}
      >
        <input
          name="subreddit"
          placeholder="SaaS"
          className="input"
          style={{ flex: "1 1 140px", minWidth: 0 }}
          required
          maxLength={200}
        />
        <input
          name="objective"
          placeholder="optional — how should Orion engage?"
          className="input"
          style={{ flex: "2 1 200px", minWidth: 0 }}
          maxLength={240}
        />
        <input
          name="minScore"
          type="number"
          min={0}
          placeholder="min ↑"
          className="input"
          style={{ flex: "0 0 90px", width: 90 }}
          inputMode="numeric"
        />
        <button className="btn btn-sm btn-accent" type="submit">Add</button>
      </form>

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {rows.map((r) => (
          <li
            key={r.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              padding: "8px 0",
              borderTop: "1px dashed var(--rule-soft)",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <a
                href={`https://www.reddit.com/r/${r.subreddit}`}
                target="_blank"
                rel="noreferrer"
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 12.5,
                  color: "inherit",
                  textDecoration: "none",
                }}
              >
                r/{r.subreddit}
              </a>
              <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 2 }}>
                {r.objective ? r.objective : "no objective"}
                {r.min_score != null ? ` · min ↑ ${r.min_score}` : ""}
              </div>
            </div>
            <form
              action={async () => {
                "use server";
                await removeRedditWatchlistEntry({ orgSlug, instanceId, rowId: r.id });
              }}
            >
              <button className="btn btn-xs" type="submit">×</button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Nova (video_intern) watchlist: two source lanes (creators + niche keywords),
 * a cost-gated "Harvest now" trigger, and a Discover grid of the top harvested
 * clips. Writes through the video_intern-gated server actions.
 */
async function VideoWatchlist({
  orgSlug,
  instanceId,
  displayName: displayNameRaw,
  objective,
}: {
  orgSlug: string;
  instanceId: string;
  displayName: string | null;
  objective: string | null;
}) {
  const fixture = channelForRole("video_intern")!;
  const displayName = displayNameRaw ?? fixture.label;
  const [sources, niches, clips, harvest, feederConfig] = await Promise.all([
    listVideoWatchlistSources(instanceId).catch(() => [] as VideoSourceRow[]),
    listVideoWatchlistNiches(instanceId).catch(() => [] as VideoNicheRow[]),
    listVideoClips(instanceId, { limit: 24 }).catch(() => [] as VideoClipRow[]),
    getVideoHarvestStatus(instanceId).catch(() => null),
    getVideoFeederConfig(instanceId).catch(() => null),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Video Growth Intern · Watchlist"
        title={<>Which creators <em>{displayName}</em> studies</>}
        sub="The IG/TikTok creators Nova learns from, plus niche keyword/hashtag lanes. Each harvest pulls their top-performing reels (by your filters), breaks down what makes them work, and distils a Video Brand Guide. Nova never posts — you record + post by hand."
        right={
          <Link href={`/app/${orgSlug}/agents/${instanceId}`} className="btn btn-sm">
            ← Back to agent
          </Link>
        }
      />

      <div style={{ marginBottom: 24 }}>
        <HarvestCard orgSlug={orgSlug} instanceId={instanceId} status={harvest} sourceCount={sources.length} />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 16,
          marginBottom: 24,
        }}
      >
        <CreatorColumn orgSlug={orgSlug} instanceId={instanceId} rows={sources} />
        <NicheColumn orgSlug={orgSlug} instanceId={instanceId} rows={niches} hasObjective={Boolean(objective?.trim())} />
      </div>

      {feederConfig ? (
        <div style={{ marginBottom: 24 }}>
          <HarvestFilters orgSlug={orgSlug} instanceId={instanceId} cfg={feederConfig} />
        </div>
      ) : null}

      <DiscoverList clips={clips} />
    </>
  );
}

function HarvestCard({
  orgSlug,
  instanceId,
  status,
  sourceCount,
}: {
  orgSlug: string;
  instanceId: string;
  status: HarvestRunStatus | null;
  sourceCount: number;
}) {
  const state = status?.state ?? "idle";
  const label: Record<string, string> = {
    running: "Harvesting…",
    requested: "Queued — Nova will harvest shortly",
    stalled: "Stalled — check the worker",
    errored: "Last run errored",
    idle: "Idle",
  };
  const busy = state === "running" || state === "requested";
  const parked = maintenanceNote("video_intern");
  return (
    <section className="card">
      <div className="card-h">
        <h3>Harvest now</h3>
        <span className="tag">{parked ? "Maintenance" : (label[state] ?? state)}</span>
      </div>
      {parked ? (
        <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>{parked}</p>
      ) : (
        <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
          Pulls the top-performing reels from your {sourceCount} watched creator{sourceCount === 1 ? "" : "s"} + niche lanes via
          Apify, applies your filters, and stores them for analysis. Costs a few cents per creator.{" "}
          {status?.lastRunAt ? `Last run ${status.lastRunAt.slice(0, 16).replace("T", " ")} UTC.` : "Not run yet."}
          {state === "errored" && status?.lastError ? ` Error: ${status.lastError}` : ""}
        </p>
      )}
      {!parked && (      <form
        action={async () => {
          "use server";
          await requestVideoHarvest({ orgSlug, instanceId });
        }}
      >
        <button
          className="btn btn-sm btn-accent"
          type="submit"
          disabled={busy || sourceCount === 0}
        >
          {busy ? "Harvest queued…" : "Harvest now"}
        </button>
      </form>)}
    </section>
  );
}

/**
 * The "tailored harvest" controls: how many videos Nova pulls per creator and
 * WHICH ones — top-N by views/engagement, measured view/follower ratios
 * (extra clips not already picked), niche recency — plus
 * the analysis + grounding tiers. A plain server-action form that rebuilds the
 * exact VideoFeederConfig the Scout harvester parses out of video_feeder_config.
 */
function HarvestFilters({
  orgSlug,
  instanceId,
  cfg,
}: {
  orgSlug: string;
  instanceId: string;
  cfg: VideoFeederConfig;
}) {
  return (
    <section className="card">
      <div className="card-h">
        <h3>Harvest filters</h3>
        <span className="tag">tailored</span>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 16px" }}>
        How many videos Nova pulls per creator, and <em>which</em> ones. Each run keeps the top
        performers by your rules, tears them down, and feeds the Brand Guide. Saved here, applied
        on the next <strong>Harvest now</strong>.
      </p>
      <form
        action={async (fd: FormData) => {
          "use server";
          const n = (k: string, d: number) => {
            const v = Number(fd.get(k));
            return Number.isFinite(v) ? v : d;
          };
          await saveVideoFeederConfig({
            orgSlug,
            instanceId,
            config: {
              topByViews: n("topByViews", cfg.topByViews),
              topByEngagement: n("topByEngagement", cfg.topByEngagement),
              outperformers: {
                ratio: n("outperformers.ratio", cfg.outperformers.ratio),
                n: n("outperformers.n", cfg.outperformers.n),
              },
              maxPerSource: n("maxPerSource", cfg.maxPerSource),
              recencyWindowDays: n("recencyWindowDays", cfg.recencyWindowDays),
              nicheTrending: {
                recencyWindowHours: n("nicheTrending.recencyWindowHours", cfg.nicheTrending.recencyWindowHours),
                minViews: n("nicheTrending.minViews", cfg.nicheTrending.minViews),
                n: n("nicheTrending.n", cfg.nicheTrending.n),
              },
              deepTierPercentile: n("deepTierPercentile", cfg.deepTierPercentile),
              maxVideoExemplars: n("maxVideoExemplars", cfg.maxVideoExemplars),
              varietyTemperature: n("varietyTemperature", cfg.varietyTemperature),
              minPerformancePercentile: n("minPerformancePercentile", cfg.minPerformancePercentile),
            },
          });
        }}
      >
        <FilterGroup label="Per creator — how many, which ones">
          <NumField name="topByViews" label="Top by views" hint="Best N clips by views. 0 = off." value={cfg.topByViews} min={0} max={100} />
          <NumField name="topByEngagement" label="Top by engagement" hint="Best N by engagement rate. 0 = off." value={cfg.topByEngagement} min={0} max={100} />
          <NumField name="maxPerSource" label="Max per creator" hint="Hard cap pulled per run (cost guard)." value={cfg.maxPerSource} min={1} max={200} />
          <NumField name="recencyWindowDays" label="Only last N days" hint="Ignore clips older than this." value={cfg.recencyWindowDays} min={1} max={365} />
        </FilterGroup>

        <FilterGroup label="Extra clips — measured views/followers ratio">
          <NumField name="outperformers.ratio" label="Views ÷ followers ≥" hint="Recorded views divided by captured followers." value={cfg.outperformers.ratio} min={1} max={50} step={0.5} />
          <NumField name="outperformers.n" label="How many" hint="Extra clips, excluding ones already picked above." value={cfg.outperformers.n} min={0} max={100} />
        </FilterGroup>

        <FilterGroup label="Niche lanes — newest top performers in a niche">
          <NumField name="nicheTrending.n" label="How many" hint="Top clips per niche keyword/hashtag lane." value={cfg.nicheTrending.n} min={0} max={100} />
          <NumField name="nicheTrending.recencyWindowHours" label="Within N hours" hint="“Newest” window — 168 = 7 days." value={cfg.nicheTrending.recencyWindowHours} min={1} max={720} />
          <NumField name="nicheTrending.minViews" label="Min views" hint="Floor so junk doesn’t qualify. 0 = none." value={cfg.nicheTrending.minViews} min={0} max={100000000} step={1000} />
        </FilterGroup>

        <FilterGroup label="Analysis & grounding">
          <NumField name="deepTierPercentile" label="Deep-pass percentile" hint="Top X% get the expensive teardown. 100 = never." value={cfg.deepTierPercentile} min={0} max={100} />
          <NumField name="maxVideoExemplars" label="Exemplars / script" hint="Proven clips each script is grounded on." value={cfg.maxVideoExemplars} min={0} max={20} />
          <NumField name="varietyTemperature" label="Variety" hint="0 = always best-fit · 1 = max variety." value={cfg.varietyTemperature} min={0} max={1} step={0.1} />
          <NumField name="minPerformancePercentile" label="Min performance %ile" hint="Exemplar eligibility floor. 0 = none." value={cfg.minPerformancePercentile} min={0} max={100} />
        </FilterGroup>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
          <button className="btn btn-sm btn-primary" type="submit">Save filters</button>
        </div>
      </form>
    </section>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset style={{ border: "none", padding: 0, margin: "0 0 18px" }}>
      <legend className="studio-sub" style={{ padding: 0, marginBottom: 10 }}>
        {label}
      </legend>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(158px, 1fr))",
          gap: 12,
        }}
      >
        {children}
      </div>
    </fieldset>
  );
}

function NumField({
  name,
  label,
  hint,
  value,
  min,
  max,
  step,
}: {
  name: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{label}</span>
      <input
        className="input"
        type="number"
        name={name}
        defaultValue={value}
        min={min}
        max={max}
        step={step ?? 1}
        style={{ width: "100%" }}
      />
      <span style={{ display: "block", fontSize: 11, color: "var(--ink-muted)", marginTop: 4, lineHeight: 1.35 }}>
        {hint}
      </span>
    </label>
  );
}

function CreatorColumn({
  orgSlug,
  instanceId,
  rows,
}: {
  orgSlug: string;
  instanceId: string;
  rows: VideoSourceRow[];
}) {
  return (
    <section className="card">
      <div className="card-h">
        <h3>Creators</h3>
        <span className="tag">{rows.length}</span>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
        The IG/TikTok creators Nova studies. Add a handle (no @). Disable one to skip it on the next harvest without removing it.
      </p>
      <form
        action={async (fd: FormData) => {
          "use server";
          const handle = String(fd.get("handle") ?? "");
          if (!handle) return;
          const platform = String(fd.get("platform") ?? "instagram") === "tiktok" ? "tiktok" : "instagram";
          await addVideoSource({ orgSlug, instanceId, handle, platform });
        }}
        style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}
      >
        <input name="handle" placeholder="chrisdoesviral" className="input" style={{ flex: "1 1 140px", minWidth: 0 }} required maxLength={200} />
        <select name="platform" className="input" style={{ flex: "0 0 110px" }} defaultValue="instagram">
          <option value="instagram">Instagram</option>
          <option value="tiktok">TikTok</option>
        </select>
        <button className="btn btn-sm btn-accent" type="submit">Add</button>
      </form>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {rows.map((r) => (
          <li
            key={r.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              padding: "8px 0",
              borderTop: "1px dashed var(--rule-soft)",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, opacity: r.enabled ? 1 : 0.5 }}>
                {r.platform === "tiktok" ? "tiktok" : "ig"} · @{r.handle}
              </span>
              <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 2 }}>
                {r.follower_count != null ? `${fmtCount(r.follower_count)} followers` : "followers unknown"}
                {r.enabled ? "" : " · disabled"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <form
                action={async () => {
                  "use server";
                  await toggleVideoSource({ orgSlug, instanceId, rowId: r.id, enabled: !r.enabled });
                }}
              >
                <button className="btn btn-xs" type="submit">{r.enabled ? "Disable" : "Enable"}</button>
              </form>
              <form
                action={async () => {
                  "use server";
                  await removeVideoSource({ orgSlug, instanceId, rowId: r.id });
                }}
              >
                <button className="btn btn-xs" type="submit">×</button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NicheColumn({
  orgSlug,
  instanceId,
  rows,
  hasObjective,
}: {
  orgSlug: string;
  instanceId: string;
  rows: VideoNicheRow[];
  hasObjective: boolean;
}) {
  return (
    <section className="card">
      <div className="card-h">
        <h3>Niche lanes</h3>
        <span className="tag">{rows.length}</span>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
        Keyword/hashtag lanes for the newest top performers in a niche (no # needed).
        Let Nova plan them from your objective, or add your own.
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
        <PlanLanesButton orgSlug={orgSlug} instanceId={instanceId} hasObjective={hasObjective} />
      </div>
      <form
        action={async (fd: FormData) => {
          "use server";
          const query = String(fd.get("query") ?? "");
          if (!query) return;
          const platform = String(fd.get("platform") ?? "instagram") === "tiktok" ? "tiktok" : "instagram";
          await addVideoNiche({ orgSlug, instanceId, query, platform });
        }}
        style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}
      >
        <input name="query" placeholder="ai founders" className="input" style={{ flex: "1 1 140px", minWidth: 0 }} required maxLength={200} />
        <select name="platform" className="input" style={{ flex: "0 0 110px" }} defaultValue="instagram">
          <option value="instagram">Instagram</option>
          <option value="tiktok">TikTok</option>
        </select>
        <button className="btn btn-sm btn-accent" type="submit">Add</button>
      </form>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {rows.map((r) => (
          <li
            key={r.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              padding: "8px 0",
              borderTop: "1px dashed var(--rule-soft)",
            }}
          >
            <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, opacity: r.enabled ? 1 : 0.5 }}>
              {r.platform === "tiktok" ? "tiktok" : "ig"} · #{r.query}
            </span>
            <form
              action={async () => {
                "use server";
                await removeVideoNiche({ orgSlug, instanceId, rowId: r.id });
              }}
            >
              <button className="btn btn-xs" type="submit">×</button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DiscoverList({ clips }: { clips: VideoClipRow[] }) {
  if (clips.length === 0) {
    return (
      <section className="card">
        <div className="card-h">
          <h3>Discover — top harvested videos</h3>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Nothing harvested yet. Add creators above and hit “Harvest now”.
        </p>
      </section>
    );
  }
  return (
    <section className="card">
      <div className="card-h">
        <h3>Discover — top harvested videos</h3>
        <span className="tag">{clips.length}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
        {clips.map((c) => (
          <a
            key={c.id}
            href={c.url}
            target="_blank"
            rel="noreferrer"
            style={{
              textDecoration: "none",
              color: "inherit",
              border: "1px solid var(--rule-soft)",
              borderRadius: 8,
              overflow: "hidden",
              display: "block",
            }}
          >
            <ClipThumb src={c.thumb_url} handle={c.author_handle} />
            <div style={{ padding: 8 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                {fmtCount(c.views)} views · {fmtCount(c.likes)} ♥{c.deep_tier ? " · ★" : ""}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--ink-muted)",
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                @{c.author_handle}
              </div>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

import type { ReactNode } from "react";
import { getOrgBySlug, loadXApiSpend } from "@/lib/queries";
import {
  getInstanceIdForRole,
  getAgentPerformance,
  getPublishedPostPerformance,
  type PublishedPostPerf,
} from "@/lib/schedule-queries";
import { CONFIG_BY_PLATFORM, platformToRole, type WorkspaceLaneView } from "@/lib/agent-content-config";
import { ChannelSetupNotice } from "./ChannelSetupNotice";
import { dayOfMonth } from "./schedule-dates";

/** Compact count, e.g. 12800 → "12.8k". */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Performance dashboard. For Vega (hasEngagementData) it LEADS with real
 * per-post engagement — impressions / likes / reposts / replies measured on the
 * posts it actually published (from noelle.own_post_metrics via the X API +
 * Apify self-track sweeps) — then shows pipeline/activity context below. The
 * draft-only agents never post, so they only get the activity view.
 */
export async function PerformancePanel({ lane, orgSlug }: { lane: WorkspaceLaneView; orgSlug: string }) {
  const org = await getOrgBySlug(orgSlug);
  if (!org || lane.platform === "all") return null;

  const role = platformToRole(lane.platform);
  const cfg = CONFIG_BY_PLATFORM[lane.platform];
  const instanceId = role ? await getInstanceIdForRole(org.id, role) : null;
  const agent = lane.identity.agent;
  const color = lane.identity.color;

  if (!instanceId) {
    return <ChannelSetupNotice orgSlug={orgSlug} role={cfg.role}>
      Set up this channel to see its content and activity.
    </ChannelSetupNotice>;
  }

  const [perf, published, xapi] = await Promise.all([
    getAgentPerformance(org.id, instanceId),
    cfg.capabilities.hasEngagementData ? getPublishedPostPerformance(org.id, instanceId) : Promise.resolve(null),
    cfg.capabilities.hasEngagementData ? loadXApiSpend(org.id) : Promise.resolve(null),
  ]);

  const hasEngagement = !!published && published.posts.length > 0;
  const trendMax = Math.max(1, ...perf.draftTrend.map((d) => d.n));

  const activityKpis: { label: string; value: number; hint?: string }[] = [
    { label: "Scheduled ahead", value: perf.scheduledAhead },
    { label: "Drafted · 7d", value: perf.draftsThisWeek },
    { label: cfg.capabilities.canAutoPost ? "Published · 7d" : "Ready · 7d", value: perf.publishedThisWeek },
    { label: "Published · all", value: perf.publishedAllTime },
  ];
  if (xapi) {
    activityKpis.push({
      label: "X API writes · mo",
      value: xapi.postsThisMonth + xapi.repliesThisMonth,
      hint: `${xapi.postsThisMonth} posts · ${xapi.repliesThisMonth} replies`,
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* ── Real engagement (Vega) — leads when there's measured data ── */}
      {hasEngagement ? <EngagementSection published={published!} color={color} /> : null}

      {/* Activity KPI strip */}
      <div>
        {hasEngagement ? (
          <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: "0.06em", color: "var(--ink-muted)", textTransform: "uppercase", marginBottom: 8, paddingLeft: 2 }}>
            Pipeline &amp; activity
          </div>
        ) : null}
        <div className="kpi-strip" style={{ display: "grid", gridTemplateColumns: `repeat(${activityKpis.length}, 1fr)`, gap: 12 }}>
          {activityKpis.map((k) => (
            <div key={k.label} className="card clay-flat" style={{ padding: "14px 16px" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: "0.06em", color: "var(--ink-muted)", textTransform: "uppercase" }}>{k.label}</div>
              <div className="serif" style={{ fontSize: 30, lineHeight: 1.05, marginTop: 6, color: "var(--ink)" }}>{k.value}</div>
              {k.hint ? <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 3 }}>{k.hint}</div> : null}
            </div>
          ))}
        </div>
      </div>

      {/* Drafting trend · 14 days */}
      <div className="card clay-flat" style={{ padding: 18 }}>
        <div className="card-h" style={{ marginBottom: 14 }}>
          <h3 className="serif" style={{ fontSize: 17 }}>Drafting · 14 days</h3>
          <span className="tag">{perf.draftTrend.reduce((a, d) => a + d.n, 0)} drafts</span>
        </div>
        {perf.draftTrend.length === 0 ? (
          <div style={{ color: "var(--ink-muted)", fontSize: 13 }}>
            Nothing drafted in the last two weeks. Plan a batch in Compose to fill the pipeline.
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 5, height: 96 }}>
            {perf.draftTrend.map((d) => (
              <div key={d.day} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }} title={`${d.day}: ${d.n}`}>
                <div
                  style={{
                    width: "100%",
                    height: `${Math.max(3, (d.n / trendMax) * 78)}px`,
                    background: `color-mix(in oklch, ${color} 70%, var(--paper-2))`,
                    borderRadius: 4,
                  }}
                />
                <span style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--ink-soft)" }}>{dayOfMonth(d.day)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pipeline status breakdown */}
      <div className="card clay-flat" style={{ padding: 18 }}>
        <div className="card-h" style={{ marginBottom: 12 }}>
          <h3 className="serif" style={{ fontSize: 17 }}>Pipeline</h3>
          {!cfg.capabilities.canAutoPost ? <span className="tag tag-ok">draft-only — you post by hand</span> : null}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {perf.byStatus.length === 0 ? (
            <span style={{ color: "var(--ink-muted)", fontSize: 13 }}>No scheduled content yet.</span>
          ) : (
            perf.byStatus.map((s) => (
              <span
                key={s.status}
                className="tag"
                style={{ fontSize: 12, background: "var(--paper-2)", boxShadow: "0 0 0 0.5px var(--rule)" }}
              >
                {s.status} · <strong style={{ fontFamily: "var(--mono)" }}>{s.n}</strong>
              </span>
            ))
          )}
        </div>
      </div>

      {/* Empty-engagement hint (only before any post has been measured) */}
      {cfg.capabilities.hasEngagementData && !hasEngagement ? (
        <div style={{ fontSize: 12, color: "var(--ink-muted)", paddingLeft: 2 }}>
          Per-post engagement (impressions · likes · reposts · replies) appears here once {agent} has published and the
          metrics sweep has read the posts back. Publish a scheduled slot, or paste a posted URL on a draft, to seed it.
        </div>
      ) : null}
      {!cfg.capabilities.hasEngagementData ? (
        <div style={{ fontSize: 12, color: "var(--ink-muted)", paddingLeft: 2 }}>
          Engagement charts (likes · replies · reach) land once {agent} is posting to a connected account.
        </div>
      ) : null}
    </div>
  );
}

/** The real-engagement lead: impression/like/repost/reply totals + a per-post table. */
function EngagementSection({ published, color }: { published: NonNullable<Awaited<ReturnType<typeof getPublishedPostPerformance>>>; color: string }) {
  const t = published.totals;
  const engagementKpis: { label: string; value: string; hint?: string }[] = [
    {
      label: "Impressions",
      value: t.impressions == null ? "—" : fmt(t.impressions),
      hint: t.impressions == null ? "connect X API for reach" : `${t.postsWithImpressions}/${t.posts} posts`,
    },
    { label: "Likes", value: fmt(t.likes) },
    { label: "Reposts", value: fmt(t.reposts) },
    { label: "Replies", value: fmt(t.replies) },
    { label: "Posts measured", value: fmt(t.posts) },
  ];
  const top = published.posts.slice(0, 12);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: "0.06em", color: "var(--ink-muted)", textTransform: "uppercase", paddingLeft: 2 }}>
        Real engagement · your published posts
      </div>
      <div className="kpi-strip" style={{ display: "grid", gridTemplateColumns: `repeat(${engagementKpis.length}, 1fr)`, gap: 12 }}>
        {engagementKpis.map((k) => (
          <div key={k.label} className="card clay-flat" style={{ padding: "14px 16px" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: "0.06em", color: "var(--ink-muted)", textTransform: "uppercase" }}>{k.label}</div>
            <div className="serif" style={{ fontSize: 30, lineHeight: 1.05, marginTop: 6, color: "var(--ink)" }}>{k.value}</div>
            {k.hint ? <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 3 }}>{k.hint}</div> : null}
          </div>
        ))}
      </div>

      <div className="card clay-flat" style={{ padding: 18 }}>
        <div className="card-h" style={{ marginBottom: 12 }}>
          <h3 className="serif" style={{ fontSize: 17 }}>Top posts by engagement</h3>
          <span className="tag">{published.posts.length} measured</span>
        </div>
        <div className="scroll-x-phone" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--ink-muted)", fontFamily: "var(--mono)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                <th style={{ padding: "6px 8px 6px 0", fontWeight: 400 }}>Post</th>
                <MetricTh>Impr.</MetricTh>
                <MetricTh>Likes</MetricTh>
                <MetricTh>Reposts</MetricTh>
                <MetricTh>Replies</MetricTh>
              </tr>
            </thead>
            <tbody>
              {top.map((p) => (
                <PostRow key={p.externalId} post={p} color={color} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function MetricTh({ children }: { children: ReactNode }) {
  return <th style={{ padding: "6px 8px", fontWeight: 400, textAlign: "right", whiteSpace: "nowrap" }}>{children}</th>;
}

function PostRow({ post, color }: { post: PublishedPostPerf; color: string }) {
  const label = post.preview && post.preview.length > 0 ? post.preview : `tweet ${post.externalId}`;
  const clipped = label.length > 90 ? `${label.slice(0, 90)}…` : label;
  return (
    <tr style={{ borderTop: "0.5px solid var(--rule)" }}>
      <td style={{ padding: "9px 8px 9px 0", maxWidth: 380 }}>
        {post.url ? (
          <a href={post.url} target="_blank" rel="noreferrer" style={{ color: "var(--ink)", textDecoration: "none" }}>
            {clipped}
          </a>
        ) : (
          <span style={{ color: "var(--ink)" }}>{clipped}</span>
        )}
      </td>
      <td style={{ padding: "9px 8px", textAlign: "right", fontFamily: "var(--mono)", color: post.views == null ? "var(--ink-soft)" : color, whiteSpace: "nowrap" }}>
        {post.views == null ? "—" : fmt(post.views)}
      </td>
      <MetricTd>{fmt(post.likes)}</MetricTd>
      <MetricTd>{fmt(post.reposts)}</MetricTd>
      <MetricTd>{fmt(post.replies)}</MetricTd>
    </tr>
  );
}

function MetricTd({ children }: { children: ReactNode }) {
  return <td style={{ padding: "9px 8px", textAlign: "right", fontFamily: "var(--mono)", color: "var(--ink)", whiteSpace: "nowrap" }}>{children}</td>;
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgBySlug, listAgentInstancesForOrg } from "@/lib/queries";
import { getOwnAccountAnalytics, listLinkableDrafts, type OwnPostRow, type LinkableDraft } from "@/lib/video-analytics-queries";
import { fmtReach, reachTone } from "@/lib/video-metrics";
import { PostAttribution } from "./PostAttribution";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; instanceId: string }>;
}

const NOVA_ACCENT = "oklch(0.58 0.13 305)";
const fmt = (n: number | null) => n === null ? "unknown" : n.toLocaleString("en-US");

// Stop-words stripped so caption↔hook overlap keys on real terms.
const STOP = new Set("the a an and or but to of in on for with my your this that is are it i you we".split(" "));
function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t)),
  );
}
/** Best caption→draft-hook overlap match, so the picker pre-selects the likely draft. */
function suggestDraftFor(caption: string, drafts: LinkableDraft[]): string | null {
  const cap = tokens(caption);
  if (cap.size === 0) return null;
  let best: { id: string; score: number } | null = null;
  for (const d of drafts) {
    if (!d.hook) continue;
    const h = tokens(d.hook);
    let overlap = 0;
    for (const t of h) if (cap.has(t)) overlap++;
    if (overlap > 0 && (!best || overlap > best.score)) best = { id: d.id, score: overlap };
  }
  return best && best.score >= 2 ? best.id : null;
}

export default async function NovaAnalyticsPage({ params }: PageProps) {
  const { orgSlug, instanceId } = await params;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();
  const all = await listAgentInstancesForOrg(org.id);
  const instance =
    all.find((i) => i.id === instanceId && i.role === "video_intern") ??
    all.find((i) => i.role === "video_intern");
  if (!instance) notFound();

  const [analytics, drafts] = await Promise.all([
    getOwnAccountAnalytics(instance.id),
    listLinkableDrafts(instance.id),
  ]);
  const { posts, handle, platform, followerCount, followerDelta } = analytics;

  const measuredViews = posts.filter((p) => p.views !== null);
  const sum = measuredViews.reduce((a, p) => a + p.views!, 0);
  const totalViews = measuredViews.length > 0 && Number.isSafeInteger(sum) ? sum : null;
  const withReach = posts.filter((p) => p.reachMultiple != null);
  const avgReach = withReach.length
    ? withReach.reduce((a, p) => a + (p.reachMultiple ?? 0), 0) / withReach.length
    : null;
  const ranked = [...withReach].sort((a, b) => (b.reachMultiple ?? 0) - (a.reachMultiple ?? 0));
  const top = ranked.slice(0, 3);
  const bottom = ranked.slice(-3).reverse().filter((p) => !top.includes(p));
  const fromDrafts = posts.filter((p) => p.draftId).length;

  const backHref = `/app/${orgSlug}/content?platform=video`;
  const watchlistHref = `/app/${orgSlug}/agents/${instance.id}/watchlist`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header className="row-between" style={{ flexWrap: "wrap", gap: 10 }}>
        <div>
          <div className="eyebrow" style={{ color: NOVA_ACCENT }}>Nova · analytics</div>
          <h1 style={{ margin: "2px 0 0" }}>What you posted{handle ? <> · <span style={{ fontFamily: "var(--mono)", fontSize: 18, color: "var(--ink-muted)" }}>@{handle}{platform ? ` · ${platform === "instagram" ? "Instagram" : "TikTok"}` : ""}</span></> : null}</h1>
          <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
            Your own tracked posts, recorded metrics, and which Nova drafts you used. Nova refreshes this every few hours.
            {handle ? " Follower change covers all measured captures for this account." : ""}
          </p>
        </div>
        <Link className="btn btn-sm" href={backHref}>← Back to Nova</Link>
      </header>

      {!handle ? (
        <div className="card clay-flat ideas-empty">
          <h3 className="serif">Track your account first</h3>
          <p>
            Add your own IG/TikTok handle as an <strong>“my account”</strong> source on the watchlist. Nova then pulls your
            posts every few hours and this page fills in with their performance over time.
          </p>
          <Link className="btn btn-sm btn-primary" href={watchlistHref}>Set up my account →</Link>
        </div>
      ) : posts.length === 0 ? (
        <div className="card clay-flat ideas-empty">
          <h3 className="serif">No posts tracked yet</h3>
          <p>Nova is set to track <strong>@{handle}</strong> but hasn’t pulled posts yet — check back after the next sweep.</p>
        </div>
      ) : (
        <>
          {/* KPI strip */}
          <div className="kpi-strip" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Kpi label="Posts tracked" value={fmt(posts.length)} />
            <Kpi label={measuredViews.length === posts.length ? "Total views" : "Measured views"} value={fmt(totalViews)} sub={`${measuredViews.length}/${posts.length} posts measured`} />
            <Kpi label="Avg views/followers" value={avgReach != null ? fmtReach(avgReach) : "—"} />
            <Kpi label="Followers" value={followerCount != null ? fmt(followerCount) : "—"} sub={followerDelta != null ? `${followerDelta >= 0 ? "+" : ""}${fmt(followerDelta)} tracked` : undefined} />
            <Kpi label="From Nova drafts" value={`${fromDrafts}/${posts.length}`} />
          </div>

          {/* What worked / didn't */}
          {ranked.length >= 2 ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
              <HighlightCard title="Highest views/followers" tone="ok" posts={top} />
              {bottom.length ? <HighlightCard title="Lower views/followers" tone="muted" posts={bottom} /> : null}
            </div>
          ) : null}

          {/* Posts table */}
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div className="scroll-x-phone">
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--ink-soft)", fontFamily: "var(--mono)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    <th style={th}>Post</th>
                    <th style={thNum}>Views</th>
                    <th style={thNum}>Likes</th>
                    <th style={thNum}>Comments</th>
                    <th style={thNum}>Views/followers</th>
                    <th style={thNum}>Growth</th>
                    <th style={th}>Draft used</th>
                  </tr>
                </thead>
                <tbody>
                  {posts.map((p) => (
                    <tr key={p.id} style={{ borderTop: "0.5px solid var(--rule)" }}>
                      <td style={td}>
                        <a href={p.url} target="_blank" rel="noreferrer" style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--ink)", textDecoration: "none", maxWidth: 320 }}>
                          {p.thumbUrl ? (
                            // Raw <img>: p.thumbUrl is an arbitrary remote host.
                            <img src={p.thumbUrl} alt="" width={34} height={46} style={{ borderRadius: 5, objectFit: "cover", flexShrink: 0, background: "var(--paper-2)" }} />
                          ) : null}
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", lineHeight: 1.3 }}>
                            {p.caption || "(no caption)"}
                          </span>
                        </a>
                      </td>
                      <td style={tdNum}>{fmt(p.views)}</td>
                      <td style={tdNum}>{fmt(p.likes)}</td>
                      <td style={tdNum}>{fmt(p.comments)}</td>
                      <td style={tdNum}>
                        {p.reachMultiple != null ? (
                          <span style={{ color: reachTone(p.reachMultiple) === "strong" ? "var(--ok, #2e7d32)" : "var(--ink)" }}>{fmtReach(p.reachMultiple)}</span>
                        ) : "—"}
                      </td>
                      <td style={tdNum}>{p.viewsGained != null ? `${p.viewsGained >= 0 ? "+" : ""}${fmt(p.viewsGained)}` : "—"}</td>
                      <td style={td}>
                        <PostAttribution
                          orgSlug={orgSlug}
                          instanceId={instance.id}
                          clipId={p.id}
                          draftId={p.draftId}
                          draftHook={p.draftHook}
                          drafts={drafts}
                          suggestedDraftId={suggestDraftFor(p.caption, drafts)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const th: React.CSSProperties = { padding: "10px 12px", fontWeight: 500 };
const thNum: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "10px 12px", verticalAlign: "middle" };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "var(--mono)", fontSize: 12 };

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card" style={{ flex: "1 1 140px", minWidth: 120, padding: "12px 14px" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--ink-soft)" }}>{label}</div>
      <div className="serif" style={{ fontSize: 24, marginTop: 4, color: "var(--ink)" }}>{value}</div>
      {sub ? <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-soft)", marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

function HighlightCard({ title, tone, posts }: { title: string; tone: "ok" | "muted"; posts: OwnPostRow[] }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="eyebrow" style={{ color: tone === "ok" ? "var(--ok, #2e7d32)" : "var(--ink-soft)" }}>{title}</div>
      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
        {posts.map((p) => (
          <a key={p.id} href={p.url} target="_blank" rel="noreferrer" style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--ink)", textDecoration: "none" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: tone === "ok" ? "var(--ok, #2e7d32)" : "var(--ink-muted)", flexShrink: 0, width: 56, textAlign: "right" }}>

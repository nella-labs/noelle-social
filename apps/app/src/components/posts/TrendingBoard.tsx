import { getOrgBySlug } from "@/lib/queries";
import { getInstanceIdForRole, getTrendingRefs } from "@/lib/schedule-queries";
import { CONFIG_BY_PLATFORM, platformToRole, type WorkspaceLaneView } from "@/lib/agent-content-config";
import { ChannelSetupNotice } from "./ChannelSetupNotice";
import { TrendingRemixButton } from "./TrendingRemixButton";

const SOURCE_LABEL: Record<string, string> = {
  handles: "the handles you track",
  connections: "your connections",
  subreddits: "your subreddits",
  creators: "the creators you track",
};

/**
 * Trending — high-engagement posts that have fuelled this agent's ideas (from
 * the inspiration refs the discovery + ideation pipeline surfaces). Each can be
 * remixed into a fresh on-brand draft. Reply routes through the normal approval
 * flow (a later wire).
 */
export async function TrendingBoard({ lane, orgSlug }: { lane: WorkspaceLaneView; orgSlug: string }) {
  const org = await getOrgBySlug(orgSlug);
  if (!org || lane.platform === "all") return null;

  const role = platformToRole(lane.platform);
  const cfg = CONFIG_BY_PLATFORM[lane.platform];
  const instanceId = role ? await getInstanceIdForRole(org.id, role) : null;
  const agent = lane.identity.agent;
  const color = lane.identity.color;

  if (!instanceId) {
    return <ChannelSetupNotice orgSlug={orgSlug} role={cfg.role}>
      Set up this channel to track what’s working in your niche.
    </ChannelSetupNotice>;
  }

  const refs = await getTrendingRefs(org.id, instanceId);
  const today = new Date().toISOString().slice(0, 10);
  const sourceLabel = SOURCE_LABEL[cfg.source.kind] ?? "the sources you track";

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h2 className="serif" style={{ fontSize: 24, lineHeight: 1, margin: 0 }}>Steal what works</h2>
        <p style={{ color: "var(--ink-muted)", fontSize: 13.5, marginTop: 6, marginBottom: 0 }}>
          High-engagement posts from {sourceLabel} that have fuelled {agent}’s drafts. Remix any into a fresh on-brand post.
        </p>
      </div>

      {refs.length === 0 ? (
        <div className="card clay-flat" style={{ padding: 24, color: "var(--ink-muted)", fontSize: 13.5 }}>
          Nothing trending yet. As {agent} discovers high-engagement posts from {sourceLabel}, they show up here as fuel to remix.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 }}>
          {refs.map((r, i) => (
            <div key={i} className="card clay-flat" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: "50%",
                    background: `color-mix(in oklch, ${color} 18%, var(--paper-2))`,
                    display: "grid",
                    placeItems: "center",
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    color,
                  }}
                >
                  {(r.author ?? "?").replace(/^@/, "").slice(0, 1).toUpperCase()}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-2)" }}>
                  {r.author ? (r.author.startsWith("@") ? r.author : `@${r.author}`) : "tracked post"}
                </span>
              </div>
              <div
                style={{
                  fontSize: 13.5,
                  lineHeight: 1.5,
                  color: "var(--ink)",
                  display: "-webkit-box",
                  WebkitLineClamp: 4,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                  minHeight: 40,
                }}
              >
                {r.note ?? "A high-engagement post in your niche."}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: "auto" }}>
                <TrendingRemixButton
                  orgSlug={orgSlug}
                  instanceId={instanceId}
                  platform={lane.platform}
                  today={today}
                  topic={`Remix this angle in ${agent}'s voice: ${r.note ?? r.url ?? "a trending post"}`}
                  color={color}
                />
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noreferrer" className="tag tag-acc" style={{ fontSize: 10.5 }}>
                    view ↗
                  </a>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

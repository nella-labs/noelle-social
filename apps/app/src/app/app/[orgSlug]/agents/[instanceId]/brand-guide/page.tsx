import { notFound } from "next/navigation";
import { getOrgBySlug, listAgentInstancesForOrg } from "@/lib/queries";
import { listVideoUltraProfiles } from "@/lib/video-queries";
import type { VideoUltraProfile } from "@noelle/contracts";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; instanceId: string }>;
}

// Plain-language pace so the card reads "fast" alongside the raw cuts/s.
function paceLabel(cutsPerSec: number | undefined): string | null {
  if (cutsPerSec == null) return null;
  if (cutsPerSec >= 0.25) return "rapid";
  if (cutsPerSec >= 0.12) return "fast";
  if (cutsPerSec >= 0.05) return "steady";
  return "slow";
}

const chipStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: "0.72rem",
  padding: "0.1rem 0.4rem",
  borderRadius: 6,
  background: "var(--rust-soft, rgba(180, 83, 9, 0.1))",
  color: "var(--rust, #9a3412)",
  whiteSpace: "nowrap",
};

const sectionLabel: React.CSSProperties = {
  fontSize: "0.7rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  fontWeight: 600,
  opacity: 0.6,
  margin: "0.85rem 0 0.4rem",
};

// Nova's Video Brand Guide — the distilled video_ultra_profiles (per creator),
// the video twin of the Styles page. Single Nova per org, so resolve by role
// (works whether the route param is the instance UUID or a slug).
export default async function BrandGuidePage({ params }: PageProps) {
  const { orgSlug, instanceId } = await params;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();
  const all = await listAgentInstancesForOrg(org.id);
  const instance =
    all.find((i) => i.id === instanceId && i.role === "video_intern") ??
    all.find((i) => i.role === "video_intern");
  if (!instance) notFound();

  const profiles = await listVideoUltraProfiles(instance.id);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <header>
        <h1 style={{ margin: 0 }}>Video Brand Guide</h1>
        <p className="muted" style={{ marginTop: "0.25rem" }}>
          What makes your watched creators&rsquo; videos work — distilled from Nova&rsquo;s teardowns.
        </p>
      </header>

      {profiles.length === 0 ? (
        <p className="muted">
          No Brand Guide yet. Once Nova harvests and analyses a creator&rsquo;s clips, their distilled
          hooks, transitions, pacing, structure, and sound show up here.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {profiles.map((row) => {
            const p = (row.profile ?? {}) as Partial<VideoUltraProfile>;
            return (
              <div key={row.id} className="card" style={{ padding: "1rem", border: "1px solid var(--border, #e5e0d8)", borderRadius: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
                  <strong>@{row.subject}</strong>
                  <span className="muted">
                    {row.platform} · {row.clips_analyzed} clips
                    {row.avg_views != null ? ` · ${Math.round(row.avg_views).toLocaleString()} avg views` : ""}
                  </span>
                </div>
                {p.whatPerforms ? <p style={{ marginTop: "0.5rem" }}>{p.whatPerforms}</p> : null}

                {/* Hooks — the actual lines that stop the scroll, not just the category. */}
                {p.hookLibrary && p.hookLibrary.length > 0 ? (
                  <>
                    <p style={sectionLabel}>Hooks that stop the scroll</p>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                      {p.hookLibrary.map((h, i) => (
                        <div key={`${h.type}-${i}`} style={{ display: "flex", gap: "0.5rem", alignItems: "baseline", flexWrap: "wrap" }}>
                          <span style={chipStyle}>{h.type.replace(/_/g, " ")}</span>
                          <span style={{ flex: 1, minWidth: "12rem" }}>
                            {h.example ? <span>&ldquo;{h.example}&rdquo;</span> : <span className="muted">no example captured</span>}
                            {h.reason ? <span className="muted"> — {h.reason}</span> : null}
                          </span>
                          {h.views != null ? (
                            <span className="muted" style={{ fontSize: "0.75rem", whiteSpace: "nowrap" }}>
                              {Math.round(h.views).toLocaleString()} views
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}

                {/* Signature structures — the beat sequences of the top clips. */}
                {p.structureTemplates && p.structureTemplates.length > 0 ? (
                  <>
                    <p style={sectionLabel}>Signature structures</p>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                      {p.structureTemplates.map((s, i) => (
                        <div key={`${s.name}-${i}`} style={{ display: "flex", gap: "0.5rem", alignItems: "baseline", flexWrap: "wrap" }}>
                          <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "0.78rem" }}>
                            {s.beats.join(" → ")}
                          </span>
                          {s.example ? (
                            <span className="muted" style={{ fontSize: "0.75rem" }}>
                              from &ldquo;{s.example}&rdquo;
                              {s.views != null ? ` · ${Math.round(s.views).toLocaleString()} views` : ""}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}

                {/* CTAs — real closing lines. */}
                {p.ctaExamples && p.ctaExamples.length > 0 ? (
                  <p className="muted" style={{ margin: "0.75rem 0 0" }}>
                    <strong>CTAs:</strong> {p.ctaExamples.map((c) => `“${c}”`).join(" · ")}
                  </p>
                ) : null}

                {p.transitionVocabulary && p.transitionVocabulary.length > 0 ? (
                  <p className="muted" style={{ margin: "0.5rem 0 0" }}>
                    <strong>Transitions:</strong> {p.transitionVocabulary.map((t) => t.replace(/_/g, " ")).join(", ")}
                  </p>
                ) : null}
                {p.soundPatterns && p.soundPatterns.length > 0 ? (
                  <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                    <strong>Sound:</strong> {p.soundPatterns.join(", ")}
                  </p>
                ) : null}
                {p.pacingFingerprint ? (
                  <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                    <strong>Pacing:</strong>{" "}
                    {paceLabel(p.pacingFingerprint.cutsPerSec) ? `${paceLabel(p.pacingFingerprint.cutsPerSec)} · ` : ""}
                    {p.pacingFingerprint.cutsPerSec?.toFixed(2) ?? "?"} cuts/s ·{" "}
                    {p.pacingFingerprint.wordsPerSec?.toFixed(1) ?? "?"} words/s
                    {p.pacingFingerprint.avgBeatSec != null ? ` · ${p.pacingFingerprint.avgBeatSec.toFixed(1)}s avg beat` : ""}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

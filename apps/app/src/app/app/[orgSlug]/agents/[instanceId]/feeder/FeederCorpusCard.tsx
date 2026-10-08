import { AppLink as Link } from "@/components/nav/AppLink";
import { timeAgo } from "@/lib/utils";
import { prettyHandle } from "@/components/approvals/StyleSourceBadge";
import { UltraProfileView } from "@/components/feeder/UltraProfileView";
import type { FeederSourceProfile, StyleSamplePost } from "@/lib/feeder-queries";
import { FeederSourceToggle } from "./FeederSourceToggle";

/**
 * Styles-page observability: for each Account-Feeder source, show whether it's
 * been pulled and styled,
 * how often its voice is actually sampled into drafts (usage %), links out to
 * the contact + LinkedIn profile, and an inline enable/disable toggle so a
 * source can be stopped right here. Expand to see the pulled posts AND how the
 * Gemini extractor interpreted the account (the shared UltraProfileView).
 */
export function FeederCorpusCard({
  orgSlug,
  instanceId,
  sources,
  samples,
}: {
  orgSlug: string;
  instanceId: string;
  sources: FeederSourceProfile[];
  samples: StyleSamplePost[];
}) {
  if (sources.length === 0) return null;

  const samplesByHandle = new Map<string, StyleSamplePost[]>();
  for (const s of samples) {
    const list = samplesByHandle.get(s.handle) ?? [];
    list.push(s);
    samplesByHandle.set(s.handle, list);
  }

  const styledCount = sources.filter((s) => s.profile != null).length;

  return (
    <section className="card">
      <div className="card-h">
        <h3>Pulled corpus &amp; style profiles</h3>
        <span className="tag">
          {styledCount} / {sources.length} styled
        </span>
      </div>
      <p style={{ fontSize: 12.5, color: "var(--ink-muted)", margin: "2px 0 12px" }}>
        What the feeder pulled from each source and how it interpreted their writing. Expand a
        source to see the actual posts and the distilled style profile the drafter samples.
      </p>

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {sources.map((s) => {
          const sourceSamples = samplesByHandle.get(s.handle) ?? [];
          const total = s.postCount + s.commentCount;
          return (
            <li key={s.sourceId} style={{ borderTop: "1px dashed var(--rule-soft)", padding: "10px 0" }}>
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <span className="serif" style={{ fontSize: 15 }}>
                  {s.displayName?.trim() || prettyHandle(s.handle)}
                </span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-soft)" }}>
                  {prettyHandle(s.handle)}
                </span>
                {/* Inline enable/disable — disabling stops this source's already-
                    pulled corpus from feeding drafts, not just the next pull. */}
                <FeederSourceToggle
                  orgSlug={orgSlug}
                  instanceId={instanceId}
                  rowId={s.sourceId}
                  enabled={s.enabled}
                />
                <span
                  className="tag"
                  style={{ fontSize: 10, color: s.profile ? "var(--accent)" : "var(--ink-muted)" }}
                  title={s.profile ? "A style profile has been distilled" : "Pulled but not yet distilled"}
                >
                  {s.profile ? "✓ styled" : "not styled yet"}
                </span>
                <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-muted)" }}>
                  {s.postCount} posts · {s.commentCount} comments
                  {s.lastPulledAt ? ` · pulled ${timeAgo(s.lastPulledAt)}` : " · not pulled"}
                </span>
              </div>

              {/* Usage attribution (how often this voice is actually sampled) +
                  deep links to the contact profile and the LinkedIn/X profile. */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 12,
                  marginTop: 6,
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                }}
              >
                <UsageStat
                  enabled={s.enabled}
                  draftsUsed={s.draftsUsed}
                  totalStyledDrafts={s.totalStyledDrafts}
                  avgWeight={s.avgWeight}
                />
                <span style={{ display: "flex", gap: 10, marginLeft: "auto" }}>
                  {s.contactPersonId ? (
                    <Link
                      href={`/app/${orgSlug}/contacts/${s.contactPersonId}`}
                      style={{ color: "var(--accent)" }}
                    >
                      Contact →
                    </Link>
                  ) : null}
                  <a
                    href={
                      s.platform === "linkedin"
                        ? `https://www.linkedin.com/in/${s.handle}`
                        : `https://x.com/${s.handle}`
                    }
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "var(--ink-soft)" }}
                  >
                    {s.platform === "linkedin" ? "LinkedIn" : "X"} ↗
                  </a>
                </span>
              </div>

              {total > 0 || s.profile ? (
                <details style={{ marginTop: 8 }}>
                  <summary
                    style={{
                      cursor: "pointer",
                      fontFamily: "var(--mono)",
                      fontSize: 11.5,
                      color: "var(--accent)",
                    }}
                  >
                    View corpus &amp; interpretation
                  </summary>

                  <div style={{ marginTop: 12, display: "grid", gap: 16 }}>
                    {s.profile ? (
                      <div>
                        <div className="eyebrow" style={{ marginBottom: 8 }}>
                          How the feeder interpreted this account
                        </div>
                        <UltraProfileView profile={s.profile} />
                      </div>
                    ) : (
                      <div style={{ fontSize: 12.5, color: "var(--ink-muted)" }}>
                        Posts were pulled but no style profile has been distilled yet — run the
                        feeder below to generate one.
                      </div>
                    )}

                    {sourceSamples.length ? (
                      <div>
                        <div className="eyebrow" style={{ marginBottom: 8 }}>
                          Top pulled posts
                        </div>
                        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
                          {sourceSamples.map((p, i) => (
                            <li
                              key={`${s.handle}-${i}`}
                              style={{
                                fontSize: 12.5,
                                color: "var(--ink-2)",
                                padding: "8px 10px",
                                background: "color-mix(in oklch, var(--ink) 3%, transparent)",
                                borderRadius: 8,
                              }}
                            >
                              <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                                <span className="tag" style={{ fontSize: 9.5 }}>
                                  {p.kind}
                                </span>
                                <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-soft)" }}>
                                  {p.likeCount ?? "unknown"} likes · {p.commentCount ?? "unknown"} comments
                                </span>
                              </div>
                              <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>
                                {p.body.length > 360 ? `${p.body.slice(0, 360)}…` : p.body}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * How often this source's voice was actually sampled into a draft. `draftsUsed`
 * of `totalStyledDrafts` styled drafts blended it in; `avgWeight` is its mean
 * share of the blend on the drafts that used it. A tiny bar makes the "% of
 * answers" legible at a glance — the operator's "what's actually being used" ask.
 */
function UsageStat({
  enabled,
  draftsUsed,
  totalStyledDrafts,
  avgWeight,
}: {
  enabled: boolean;
  draftsUsed: number;
  totalStyledDrafts: number;
  avgWeight: number | null;
}) {
  if (totalStyledDrafts === 0) {
    return <span style={{ color: "var(--ink-muted)" }}>no styled drafts yet</span>;
  }
  const pct = Math.round((draftsUsed / totalStyledDrafts) * 100);
  const sharePct = avgWeight != null ? Math.round(avgWeight * 100) : null;
  return (
    <span
      title={`Sampled into ${draftsUsed} of ${totalStyledDrafts} styled drafts${
        sharePct != null ? ` · ~${sharePct}% of the style blend when used` : ""
      }${enabled ? "" : " · disabled, excluded from new drafts"}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--ink-2)" }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-block",
          width: 54,
          height: 5,
          borderRadius: 999,
          background: "color-mix(in oklch, var(--ink) 10%, transparent)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <span
          style={{
            position: "absolute",
            inset: 0,
            width: `${pct}%`,
            background: enabled ? "var(--accent)" : "var(--ink-soft)",
          }}
        />
      </span>
      <span>
        used in {pct}% of answers
        {sharePct != null ? ` · ${sharePct}% share` : ""}
      </span>
    </span>
  );
}

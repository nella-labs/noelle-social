import type { UltraProfileView as UltraProfile } from "@/lib/feeder-queries";

/**
 * Presentational render of a style source's Gemini "ultra profile" — the way the
 * feeder interpreted an account's writing (voice, tone, structure, hooks,
 * signature phrasings, topics). Shared by the Contacts page (style-source card)
 * and the Styles/feeder page so "how the Gemini agent interpreted it" looks the
 * same everywhere. Pure server component, no interactivity.
 */
export function UltraProfileView({ profile }: { profile: UltraProfile }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {profile.voiceSummary ? (
        <p className="serif" style={{ fontSize: 15, lineHeight: 1.45, margin: 0 }}>
          {profile.voiceSummary}
        </p>
      ) : null}

      {profile.tone ? (
        <Line label="Tone" value={profile.tone} />
      ) : null}
      {profile.structureNotes ? (
        <Line label="Structure" value={profile.structureNotes} />
      ) : null}

      {profile.hookPatterns.length ? (
        <Chips label="Hooks" items={profile.hookPatterns} />
      ) : null}
      {profile.signaturePhrases.length ? (
        <Chips label="Signature phrasings" items={profile.signaturePhrases} />
      ) : null}
      {profile.topTopics.length ? (
        <Chips label="Topics" items={profile.topTopics} />
      ) : null}

      <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-soft)" }}>
        {profile.postsAnalyzed} posts analyzed
        {profile.model ? ` · ${profile.model}` : ""}
      </div>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
      <strong>{label}:</strong> {value}
    </div>
  );
}

function Chips({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {items.map((it, i) => (
          <span key={`${label}-${i}`} className="tag">
            {it}
          </span>
        ))}
      </div>
    </div>
  );
}

import { getOrgBySlug } from "@/lib/queries";
import { getInstanceIdForRole, getInstanceBrandConfig } from "@/lib/schedule-queries";
import { CONFIG_BY_PLATFORM, platformToRole, type WorkspaceLaneView } from "@/lib/agent-content-config";
import { parseBrandConfig, brandConfigHasContent } from "@noelle/contracts";
import { AppLink } from "@/components/nav/AppLink";
import { ChannelSetupNotice } from "./ChannelSetupNotice";

/**
 * Voice — the structured snapshot of how the agent writes (persona, tone, length
 * habits, avoided phrases), the prompt prefix on every draft. Backed by
 * agent_instances.brand_config + the vault. Read-first; editing rides the
 * existing vault / configure-agent surfaces.
 */
export async function VoiceProfile({ lane, orgSlug }: { lane: WorkspaceLaneView; orgSlug: string }) {
  const org = await getOrgBySlug(orgSlug);
  if (!org || lane.platform === "all") return null;

  const role = platformToRole(lane.platform);
  const instanceId = role ? await getInstanceIdForRole(org.id, role) : null;
  const agent = lane.identity.agent;
  const color = lane.identity.color;

  if (!instanceId) {
    return <ChannelSetupNotice orgSlug={orgSlug} role={CONFIG_BY_PLATFORM[lane.platform].role}>
      Set up this channel to shape its voice.
    </ChannelSetupNotice>;
  }

  const brand = parseBrandConfig(await getInstanceBrandConfig(org.id, instanceId));
  const hasContent = brandConfigHasContent(brand);

  const lengthBits: string[] = [];
  if (brand.dm_style?.len_min || brand.dm_style?.len_max) {
    lengthBits.push(`${brand.dm_style.len_min ?? "?"}–${brand.dm_style.len_max ?? "?"} chars`);
  }
  if (brand.dm_style?.fragments_min || brand.dm_style?.fragments_max) {
    lengthBits.push(`${brand.dm_style.fragments_min ?? "?"}–${brand.dm_style.fragments_max ?? "?"} fragments`);
  }

  return (
    <div className="card clay-flat" style={{ padding: 22, maxWidth: 760 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
        <h2 className="serif" style={{ fontSize: 26, lineHeight: 1 }}>Voice</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <AppLink href={`/app/${orgSlug}/vault`} className="btn btn-sm">◆ Vault</AppLink>
          <AppLink href={`/app/${orgSlug}/agents/${instanceId}`} className="btn btn-sm btn-primary">Manage voice →</AppLink>
        </div>
      </div>
      <p style={{ color: "var(--ink-muted)", fontSize: 13.5, marginTop: 0, marginBottom: 20 }}>
        The structured snapshot of how {agent} writes. Noelle uses this as the prompt prefix on every draft.
      </p>

      {!hasContent ? (
        <div style={{ color: "var(--ink-muted)", fontSize: 13.5 }}>
          No voice configured yet. Set {agent}’s persona, tone and avoided phrases in the vault’s
          <code style={{ fontFamily: "var(--mono)", margin: "0 4px" }}>02-brand/brand.md</code>
          or via Configure agent, and it’ll show here.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          {brand.persona?.bio ? (
            <Section label="Persona">
              <div style={{ fontSize: 15, lineHeight: 1.55, color: "var(--ink-2)" }}>
                {brand.persona.name ? <strong>{brand.persona.name}. </strong> : null}
                {brand.persona.bio}
              </div>
            </Section>
          ) : null}

          {brand.reply_style?.voice_notes ? (
            <Section label="Tone">
              <div style={{ fontSize: 15, lineHeight: 1.55, color: "var(--ink-2)" }}>{brand.reply_style.voice_notes}</div>
            </Section>
          ) : null}

          {lengthBits.length > 0 ? (
            <Section label="Length habits">
              <div style={{ fontSize: 15, color: "var(--ink-2)" }}>{lengthBits.join(" · ")}</div>
            </Section>
          ) : null}

          {brand.reply_style?.never_do && brand.reply_style.never_do.length > 0 ? (
            <Section label="Avoided">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {brand.reply_style.never_do.map((phrase, i) => (
                  <span
                    key={i}
                    className="tag"
                    style={{ fontSize: 12.5, color: "var(--ink-2)", background: "var(--paper-2)", boxShadow: `0 0 0 0.5px color-mix(in oklch, ${color} 30%, var(--rule))` }}
                  >
                    {phrase}
                  </span>
                ))}
              </div>
            </Section>
          ) : null}

          {brand.product?.name ? (
            <Section label={`Product · pitches ${brand.pitch_policy.replace("_", " ")}`}>
              <div style={{ fontSize: 14.5, lineHeight: 1.55, color: "var(--ink-2)" }}>
                <strong>{brand.product.name}</strong>
                {brand.product.description ? ` — ${brand.product.description}` : null}
              </div>
            </Section>
          ) : null}

          {brand.qa.length > 0 ? (
            <Section label="Brand Q&A">
              <div style={{ fontSize: 13.5, color: "var(--ink-muted)" }}>
                {brand.qa.length} answered question{brand.qa.length === 1 ? "" : "s"} grounding every draft.
              </div>
            </Section>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: "0.08em", color: "var(--ink-muted)", textTransform: "uppercase", marginBottom: 8 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

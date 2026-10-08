import { AppLink as Link } from "@/components/nav/AppLink";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/nav/PageHeader";
import styles from "@/components/contacts/contacts.module.css";
import {
  getLinkedInProfileForOrg,
  getOrgBySlug,
  getPersonForOrg,
  getPersonProfileForOrg,
  getPersonStatsForOrg,
  getWatchersForPerson,
  listAgentInstancesForOrg,
  listPersonInteractionsForOrg,
  type PersonSocialAccountView,
} from "@/lib/queries";
import { getStyleSourceForPerson } from "@/lib/feeder-queries";
import { UltraProfileView } from "@/components/feeder/UltraProfileView";
import { agentSlug } from "@/lib/agent-route";
import { timeAgo } from "@/lib/utils";
import { requestContactProfileRefresh, updatePersonProfile } from "../contacts-actions";
import { DeferredDmActions } from "@/components/contacts/DeferredDmActions";
import { GenerateDmButton } from "@/components/contacts/GenerateDmButton";
import { ReloadForm } from "@/components/ReloadForm";
import { SubmitButton } from "@/components/SubmitButton";
import {
  ContactWatchlistCard,
  type AddableAgent,
  type ContactWatcherView,
} from "../ContactWatchlistCard";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; personId: string }>;
}

/** Social platforms we show a slot for, even when not yet connected. */
const PLATFORMS: Array<{
  key: PersonSocialAccountView["platform"];
  label: string;
}> = [
  { key: "x", label: "X" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "reddit", label: "Reddit" },
];

export default async function ContactDetailPage({ params }: PageProps) {
  const { orgSlug, personId } = await params;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();

  const person = await getPersonForOrg(org.id, personId);
  if (!person) notFound();

  // Stats + interaction history key on leads.author_handle, which holds the X
  // handle for X leads and the LinkedIn public_id for LinkedIn leads — so one
  // generic handle drives both. The profiler writes to a per-platform table, so
  // pick "Lyra" + the LinkedIn profile when the contact is LinkedIn-only.
  const handle = person.xHandle ?? person.linkedinHandle;
  const isLinkedIn = !person.xHandle && Boolean(person.linkedinHandle);
  const profilerName = isLinkedIn ? "Lyra" : "Vega";
  const [profile, stats, interactions] = handle
    ? await Promise.all([
        isLinkedIn
          ? getLinkedInProfileForOrg(org.id, handle)
          : getPersonProfileForOrg(org.id, handle),
        getPersonStatsForOrg(org.id, handle),
        listPersonInteractionsForOrg(org.id, handle),
      ])
    : [null, null, []];

  // Watchlist membership loads regardless of handle — a handle-less contact
  // still resolves its (empty) watcher set by person_id and shows the section.
  // styleSource: is this contact also one of Lyra's Account-Feeder source
  // accounts? This connects the Styles and Contacts surfaces.
  const [watchers, instances, styleSource] = await Promise.all([
    getWatchersForPerson(org.id, personId, handle),
    listAgentInstancesForOrg(org.id).catch(() => []),
    getStyleSourceForPerson(org.id, {
      xHandle: person.xHandle,
      linkedinHandle: person.linkedinHandle,
    }).catch(() => null),
  ]);

  // Resolve the feeder page link for the agent that learns from this source.
  const styleAgent = styleSource
    ? instances.find((i) => i.id === styleSource.agentInstanceId)
    : undefined;
  const styleFeederHref = styleSource
    ? `/app/${orgSlug}/agents/${agentSlug(styleAgent?.display_name ?? "Lyra", styleSource.agentInstanceId)}/feeder`
    : null;

  // Resolve each watcher's URL slug from the live instance (its real display
  // name), so the "Watched by" links land on the right agent even if the
  // watchlist row's cached name drifted.
  const watcherViews: ContactWatcherView[] = watchers.map((w) => ({
    ...w,
    agentSlug: agentSlug(
      instances.find((i) => i.id === w.agentInstanceId)?.display_name ?? w.agentName,
      w.agentInstanceId,
    ),
  }));
  // X-intern agents that don't yet watch this contact — offered in the add form.
  const watchingIds = new Set(watchers.map((w) => w.agentInstanceId));
  const addableAgents: AddableAgent[] = instances
    .filter((i) => i.role === "x_intern" && !watchingIds.has(i.id))
    .map((i) => ({ instanceId: i.id, name: i.display_name?.trim() || "X intern" }));

  return (
    <div className={styles.detail}>
      <PageHeader
        eyebrow="Contacts"
        title={person.displayName}
        sub={
          person.xHandle
            ? `@${person.xHandle} on X`
            : person.linkedinHandle
              ? `${person.linkedinHandle} on LinkedIn`
              : "No social accounts linked yet."
        }
        right={
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <GenerateDmButton orgSlug={orgSlug} personId={personId} />
            <Link href={`/app/${orgSlug}/contacts`} className="btn btn-sm">
              ← All contacts
            </Link>
          </div>
        }
      />

      <div className={styles.detailGrid}>
        {/* Linked accounts */}
        <section className="card">
          <div className="card-h">
            <h3>Linked accounts</h3>
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {PLATFORMS.map((pl) => {
              const acct = person.accounts.find((a) => a.platform === pl.key);
              return (
                <AccountRow
                  key={pl.key}
                  label={pl.label}
                  account={acct}
                />
              );
            })}
          </ul>
        </section>

        {/* More info — CRM notes */}
        <section className="card">
          <div className="card-h">
            <h3>More info</h3>
          </div>
          <form
            action={async (formData: FormData) => {
              "use server";
              await updatePersonProfile({
                orgSlug,
                personId,
                displayName: String(formData.get("displayName") ?? ""),
                notes: String(formData.get("notes") ?? ""),
              });
            }}
            style={{ display: "grid", gap: 10 }}
          >
            <label style={{ display: "grid", gap: 4 }}>
              <span className="eyebrow">Display name</span>
              <input
                name="displayName"
                defaultValue={person.displayName}
                className="input"
                placeholder={handle ? `@${handle}` : "Name"}
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span className="eyebrow">Notes</span>
              <textarea
                name="notes"
                defaultValue={person.notes ?? ""}
                rows={5}
                className="input"
                placeholder="Context, relationship, anything worth remembering…"
                style={{ resize: "vertical", fontFamily: "inherit" }}
              />
            </label>
            <div>
              <button type="submit" className="btn btn-sm">
                Save
              </button>
            </div>
          </form>
        </section>
      </div>

      {/* Style source — when this contact is also one of Lyra's Account-Feeder
          source accounts, surface that link + the Gemini interpretation. */}
      {styleSource ? (
        <section className="card" style={{ marginBottom: 24 }}>
          <div className="card-h">
            <h3>Style source</h3>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span className="tag" style={{ color: styleSource.enabled ? "var(--accent)" : undefined }}>
                {styleSource.enabled ? "On" : "Off"}
              </span>
              {styleFeederHref ? (
                <Link href={styleFeederHref} className="btn btn-xs">
                  Open in Styles →
                </Link>
              ) : null}
            </div>
          </div>
          <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "2px 0 10px" }}>
            {styleAgent?.display_name?.trim() || "Lyra"} learns writing style from this account.
            Pulled <strong>{styleSource.postCount}</strong> posts and{" "}
            <strong>{styleSource.commentCount}</strong> comments
            {styleSource.lastPulledAt ? ` · last pulled ${timeAgo(styleSource.lastPulledAt)}` : " · not pulled yet"}.
          </p>
          {styleSource.profile ? (
            <>
              <div className="eyebrow" style={{ marginBottom: 8 }}>
                How the feeder interpreted this account
              </div>
              <UltraProfileView profile={styleSource.profile} />
            </>
          ) : (
            <div style={{ fontSize: 13, color: "var(--ink-muted)" }}>
              Posts were pulled, but no style profile has been distilled yet. Run the feeder
              from the Styles page to generate one.
            </div>
          )}
        </section>
      ) : null}

      {/* Watched by — the watchlist face of this contact (objectives + add/remove) */}
      <div style={{ marginBottom: 24 }}>
        <ContactWatchlistCard
          orgSlug={orgSlug}
          handle={person.xHandle}
          watchers={watcherViews}
          addableAgents={addableAgents}
        />
      </div>

      {/* Profile + stats (whichever platform the contact is reached on) */}
      {handle ? (
        <div className={styles.detailGrid}>
          <section className="card">
            <div className="card-h">
              <h3>What {profilerName} knows</h3>
              <ReloadForm
                action={async () => {
                  "use server";
                  await requestContactProfileRefresh({ orgSlug, personId });
                }}
              >
                <SubmitButton className="btn btn-xs" title="Re-profile on the next profiler tick">
                  Refresh
                </SubmitButton>
              </ReloadForm>
            </div>
            {profile ? (
              <>
                <p className="serif" style={{ fontSize: 16, lineHeight: 1.45, margin: "6px 0 10px" }}>
                  {profile.summary}
                </p>
                {profile.tone ? (
                  <div style={{ fontSize: 12.5, color: "var(--ink-muted)", marginBottom: 8 }}>
                    <strong>Tone:</strong> {profile.tone}
                  </div>
                ) : null}
                {profile.topics.length ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                    {profile.topics.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
                {profile.engagementNotes ? (
                  <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginBottom: 10 }}>
                    <strong>How to engage:</strong> {profile.engagementNotes}
                  </div>
                ) : null}
                <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-soft)" }}>
                  {profile.postsAnalyzed} posts analyzed
                  {profile.generatedAt ? ` · generated ${timeAgo(profile.generatedAt)}` : ""}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, color: "var(--ink-muted)" }}>
                No profile yet — {profilerName} builds one from their recent posts once
                they&apos;re an active target. Hit Refresh to nudge it.
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-h">
              <h3>Stats &amp; tendencies</h3>
            </div>
            <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 16px", margin: 0, fontSize: 13 }}>
              <Stat label="Posts seen" value={String(stats?.postsSeen ?? 0)} />
              <Stat label="Replies sent" value={String(stats?.repliesSent ?? 0)} />
              <Stat label="Pending replies" value={String(stats?.pendingReplies ?? 0)} />
              <Stat
                label="Last interaction"
                value={stats?.lastInteractionAt ? timeAgo(stats.lastInteractionAt) : "—"}
              />
            </dl>
            {stats?.topTopics.length ? (
              <div style={{ marginTop: 12 }}>
                <div className="eyebrow" style={{ marginBottom: 6 }}>
                  Tends to post
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {stats.topTopics.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {/* Interaction history */}
      <section className="card">
        <div className="card-h">
          <h3>Interaction history</h3>
          <span className="tag">{interactions.length}</span>
        </div>
        {interactions.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--ink-muted)" }}>
            No replies or DMs drafted for this person yet.
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {interactions.map((it) => {
              const parkedDm = it.status === "deferred" && it.kind === "dm";
              return (
              <li
                key={it.approvalId}
                style={{
                  padding: "10px 0",
                  borderTop: "1px dashed var(--rule-soft)",
                  ...(parkedDm
                    ? {
                        background:
                          "color-mix(in oklch, var(--accent) 6%, transparent)",
                        borderRadius: 8,
                        padding: "12px",
                      }
                    : {}),
                }}
              >
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
                  <span className="tag">{it.kind}</span>
                  <span
                    className="tag"
                    style={parkedDm ? { color: "var(--accent)" } : undefined}
                  >
                    {parkedDm ? "waiting for reply" : it.status}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--ink-soft)", fontFamily: "var(--mono)" }}>
                    {it.decidedAt ? timeAgo(it.decidedAt) : "pending"}
                  </span>
                  <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    {it.sourcePostUrl ? (
                      <a href={it.sourcePostUrl} target="_blank" rel="noreferrer" className="btn btn-xs">
                        View post →
                      </a>
                    ) : null}
                    {it.postUrl ? (
                      <a href={it.postUrl} target="_blank" rel="noreferrer" className="btn btn-xs">
                        View reply →
                      </a>
                    ) : null}
                  </span>
                </div>
                {/* Parked DMs show the full text + Send actions so you can fire
                    it once you see the person reply on X. */}
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--ink-2)",
                    whiteSpace: parkedDm ? "pre-wrap" : "normal",
                  }}
                >
                  {(parkedDm ? it.body : it.bodyPreview) ?? "—"}
                </div>
                {parkedDm && it.body ? (
                  <DeferredDmActions
                    orgSlug={orgSlug}
                    approvalId={it.approvalId}
                    body={it.body}
                    recipientId={it.recipientId}
                  />
                ) : null}
              </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function AccountRow({
  label,
  account,
}: {
  label: string;
  account: PersonSocialAccountView | undefined;
}) {
  const href =
    account?.url ??
    (account?.platform === "x" && account.handle ? `https://x.com/${account.handle}` : null);
  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 0",
        borderTop: "1px dashed var(--rule-soft)",
      }}
    >
      <span style={{ width: 80, fontWeight: 600, fontSize: 13 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--ink-2)" }}>
        {account?.handle ? `@${account.handle}` : account?.url ?? "Not linked"}
      </span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="btn btn-xs">
          Open →
        </a>
      ) : null}
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={{ color: "var(--ink-muted)" }}>{label}</dt>
      <dd style={{ margin: 0, fontFamily: "var(--mono)", textAlign: "right" }}>{value}</dd>
    </>
  );
}

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

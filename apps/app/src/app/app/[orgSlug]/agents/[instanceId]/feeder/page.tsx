import { AppLink as Link } from "@/components/nav/AppLink";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/nav/PageHeader";
import {
  getOrgBySlug,
  getAgentInstance,
  listAgentInstancesForOrg,
} from "@/lib/queries";
import {
  listFeederSources,
  getFeederRunStatus,
  listFeederSourceProfiles,
  listStyleSamples,
} from "@/lib/feeder-queries";
import { AGENT_UUID_RE, matchAgentBySlug } from "@/lib/agent-route";
import { readStyleExemplarKinds } from "@noelle/runtime";
import { FeederSourcesCard } from "./FeederSourcesCard";
import { FeederRunCard } from "./FeederRunCard";
import { FeederCorpusCard } from "./FeederCorpusCard";
import { StyleKindToggle } from "./StyleKindToggle";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; instanceId: string }>;
}

/**
 * Account Feeder ("style sources") subpage. LinkedIn-intern only — Lyra learns a
 * human writing style from admired source accounts. Two cards: the curated
 * source-list manager (reuses WatchlistPeoplePanel) and the cost-gated Run card
 * (flips account_feeder_run_requested_at; the F5 worker polls it and does the
 * paid pull). Resolution mirrors the watchlist subpage: UUID or slug → real
 * instance, then a role gate.
 */
export default async function FeederPage({ params }: PageProps) {
  const { orgSlug, instanceId } = await params;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();

  const instance = AGENT_UUID_RE.test(instanceId)
    ? await getAgentInstance(instanceId)
    : matchAgentBySlug(
        await listAgentInstancesForOrg(org.id).catch(() => []),
        instanceId,
      );
  if (!instance || instance.org_id !== org.id) notFound();
  // The feeder is the LinkedIn intern's (Lyra's) style-learning surface only.
  if (instance.role !== "linkedin_intern") notFound();

  const [sources, runStatus, sourceProfiles, styleSamples] = await Promise.all([
    listFeederSources(instance.id).catch(() => []),
    getFeederRunStatus(instance.id).catch(() => null),
    listFeederSourceProfiles(instance.id).catch(() => []),
    listStyleSamples(instance.id).catch(() => []),
  ]);
  const enabledSourceCount = sources.filter((s) => s.enabled).length;

  return (
    <>
      <PageHeader
        eyebrow="LinkedIn Growth Intern · Style sources"
        title={
          <>
            Accounts <em>{instance.display_name ?? "Lyra"}</em> learns style from
          </>
        }
        sub="Curate the accounts whose writing you admire. On a manual run, the feeder pulls their recent posts + authored comments, ranks them by engagement, and distils each into a style profile the drafter samples — so replies read like real high-performing humans, not AI. Pulls are paid and on-demand; nothing runs automatically."
        right={
          <Link href={`/app/${orgSlug}/agents/${instanceId}`} className="btn btn-sm">
            ← Back to agent
          </Link>
        }
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <FeederSourcesCard orgSlug={orgSlug} instanceId={instance.id} sources={sources} />

        <StyleKindToggle
          orgSlug={orgSlug}
          instanceId={instance.id}
          current={
            readStyleExemplarKinds(instance.account_feeder_config).includes("comment")
              ? "both"
              : "posts"
          }
        />

        {runStatus ? (
          <FeederRunCard
            orgSlug={orgSlug}
            instanceId={instance.id}
            status={runStatus}
            enabledSourceCount={enabledSourceCount}
          />
        ) : null}

        <FeederCorpusCard
          orgSlug={orgSlug}
          instanceId={instance.id}
          sources={sourceProfiles}
          samples={styleSamples}
        />
      </div>
    </>
  );
}

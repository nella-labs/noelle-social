import { notFound } from "next/navigation";
import { PageHeader } from "@/components/nav/PageHeader";
import { getOrgBySlug, listPersonsForOrg, reconcileContactsForOrg } from "@/lib/queries";
import { listStyleSourceKeysForOrg } from "@/lib/feeder-queries";
import { ContactsBrowser } from "./ContactsBrowser";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string }>;
}

/**
 * Contacts — the org-wide CRM of people Noelle's agents engage with. A contact
 * is a person (not a per-agent watchlist row) and can hold multiple social
 * accounts. X is live today; LinkedIn + Reddit are reserved for upcoming
 * integrations and show as inactive on the detail page.
 *
 * The list is searchable (by handle or name) via ContactsBrowser so you can
 * look someone up when they reply and jump straight to their history.
 */
export default async function ContactsPage({ params }: PageProps) {
  const { orgSlug } = await params;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();

  // Self-heal first: materialize a contact for everyone watched or replied-to,
  // so people seeded straight into the DB (bypassing the add-hooks) still show.
  // Best-effort — a reconcile hiccup must never blank the list below.
  await reconcileContactsForOrg(org.id).catch(() => {});

  const [people, styleSourceKeys] = await Promise.all([
    listPersonsForOrg(org.id),
    listStyleSourceKeysForOrg(org.id).catch(() => []),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="People"
        sub="Your relationships across channels. Find a person, review their history, and keep the conversation moving."
      />

      <ContactsBrowser orgSlug={orgSlug} people={people} styleSourceKeys={styleSourceKeys} />
    </>
  );
}

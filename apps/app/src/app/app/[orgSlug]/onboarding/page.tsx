import { notFound } from "next/navigation";
import { PageHeader } from "@/components/nav/PageHeader";
import { AppLink as Link } from "@/components/nav/AppLink";
import { GuidedPanel } from "@/components/guided/GuidedPanel";
import { loadGuidedSetup } from "@/lib/guided/load";
import { getOrgBySlug } from "@/lib/queries";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string }>;
}

/**
 * The guided setup hub.
 *
 * Reachable at any time, including after the panel has been hidden from the
 * dashboard. There is no redirect in or out of this route — the wizard it
 * replaces bounced the dashboard root into `/onboarding/vault`, which looped.
 */
export default async function GuidedSetupPage({ params }: PageProps) {
  const { orgSlug } = await params;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();

  const guided = await loadGuidedSetup({ orgId: org.id, orgSlug });

  return (
    <>
      <PageHeader
        eyebrow={`${org.name} · Workspace`}
        title={
          <>
            Guided <em>setup</em>
          </>
        }
        sub="Five steps to your first approved draft. Nothing here posts anything."
      />

      <GuidedPanel orgSlug={orgSlug} {...guided} variant="page" />

      <section className="card" style={{ padding: 22 }}>
        <div className="eyebrow">how noelle works</div>
        <p style={{ maxWidth: "70ch", lineHeight: 1.6, marginTop: 10 }}>
          Each intern runs the same loop: it <strong>discovers</strong> posts from the targets you
          give it, <strong>classifies</strong> which ones are worth answering, then{" "}
          <strong>drafts</strong> a reply in your voice. Every draft lands in{" "}
          <Link href={`/app/${orgSlug}/approvals`}>Approvals</Link> and waits for you.
        </p>
        <p style={{ maxWidth: "70ch", lineHeight: 1.6, marginTop: 12 }}>
          Vega (X) and Orion (Reddit) can post — Vega after you connect X and turn reply
          sending on, Orion auto-sends approved replies via the Reddit actuator (Skip any you
          don&rsquo;t want to go out). Lyra and Nova are draft-only by design — they hand you
          text, you decide where it goes.
        </p>
      </section>
    </>
  );
}

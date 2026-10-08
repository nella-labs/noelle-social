import { notFound, redirect } from "next/navigation";
import { getOrgBySlug } from "@/lib/queries";
import { getVaultForOrg, getVaultWizardAnswersForOrg } from "@/lib/vault";
import { AppLink as Link } from "@/components/nav/AppLink";
import { LightStep } from "./LightStep";
import { MediumStep } from "./MediumStep";
import { RichStep } from "./RichStep";
import { ImportStep } from "./ImportStep";
import styles from "./styles.module.css";

interface Props {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ step?: string }>;
}

export default async function VaultWizardPage({ params, searchParams }: Props) {
  const { orgSlug } = await params;
  const { step } = await searchParams;
  const org = await getOrgBySlug(orgSlug);
  if (!org) notFound();

  const [vault, answers] = await Promise.all([
    getVaultForOrg(org.id),
    getVaultWizardAnswersForOrg(org.id),
  ]);

  // Determine which step to render. URL ?step= wins when present; otherwise
  // pick based on wizard_stage. `import` is a side-route that lets the user
  // skip the Q&A and bulk-upload a markdown folder instead.
  const explicit =
    step === "light" || step === "medium" || step === "rich" || step === "import" ? step : null;
  const next = explicit ?? deriveNext(vault?.wizard_stage ?? null);
  if (next === "done") redirect(`/app/${orgSlug}/settings`);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>vault setup</p>
        <h1 className={styles.title}>
          {next === "import" ? (
            <>Import an existing <em>vault</em>.</>
          ) : next === "light" ? (
            <>Tell your agents <em>who they sound like</em>.</>
          ) : next === "medium" ? (
            <>Sharpen the <em>voice</em>.</>
          ) : (
            <>Anchor with <em>real examples</em>.</>
          )}
        </h1>
        <p className={styles.progress}>
          {next === "import"
            ? "Bring your own markdown"
            : `Step ${next === "light" ? 1 : next === "medium" ? 2 : 3} of 3`}
        </p>
        {next === "light" && (
          <p className={styles.progress} style={{ marginTop: 6 }}>
            Already have a vault?{" "}
            <Link href={`/app/${orgSlug}/onboarding/vault?step=import`}>
              Import an existing folder of markdown
            </Link>{" "}
            instead.
          </p>
        )}
      </header>
      {next === "import" && (
        <ImportStep orgId={org.id} orgSlug={orgSlug} />
      )}
      {next === "light" && (
        <LightStep orgId={org.id} orgSlug={orgSlug} initial={(answers?.answers as Record<string, unknown> | null) ?? null} />
      )}
      {next === "medium" && (
        <MediumStep orgId={org.id} orgSlug={orgSlug} initial={(answers?.answers as Record<string, unknown> | null) ?? null} />
      )}
      {next === "rich" && (
        <RichStep orgId={org.id} orgSlug={orgSlug} initial={(answers?.answers as Record<string, unknown> | null) ?? null} />
      )}
    </div>
  );
}

function deriveNext(
  stage: "light" | "medium" | "rich" | null,
): "light" | "medium" | "rich" | "import" | "done" {
  switch (stage) {
    case null:
      return "light";
    case "light":
      return "medium";
    case "medium":
      return "rich";
    case "rich":
      return "done";
  }
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import styles from "./styles.module.css";
import { submitVaultStage } from "./actions";

interface Props {
  orgId: string;
  orgSlug: string;
  initial: Record<string, unknown> | null;
}

export function LightStep({ orgId, orgSlug, initial }: Props) {
  const router = useRouter();
  const [personName, setPersonName] = useState(String(initial?.personName ?? ""));
  const [oneLineWhat, setOneLineWhat] = useState(String(initial?.oneLineWhat ?? ""));
  const [audience, setAudience] = useState(String(initial?.audience ?? ""));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setTopError(null);
    startTransition(async () => {
      const res = await submitVaultStage({
        orgId,
        orgSlug,
        stage: "light",
        answers: { personName, oneLineWhat, audience },
      });
      if (!res.ok) {
        if ("fieldErrors" in res && res.fieldErrors) setErrors(res.fieldErrors);
        setTopError(res.error);
        return;
      }
      router.push(`/app/${orgSlug}/onboarding/vault?step=medium`);
    });
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="personName">Who is the voice?</label>
        <span className={styles.hint}>One name. Person or company.</span>
        <input id="personName" className={styles.input} value={personName} onChange={(e) => setPersonName(e.target.value)} required />
        {errors.personName && <span className={styles.error}>{errors.personName}</span>}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="oneLineWhat">In one sentence, what do you do?</label>
        <input id="oneLineWhat" className={styles.input} value={oneLineWhat} onChange={(e) => setOneLineWhat(e.target.value)} required />
        {errors.oneLineWhat && <span className={styles.error}>{errors.oneLineWhat}</span>}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="audience">Who are you talking to?</label>
        <input id="audience" className={styles.input} value={audience} onChange={(e) => setAudience(e.target.value)} required />
        {errors.audience && <span className={styles.error}>{errors.audience}</span>}
      </div>

      {topError && <span className={styles.error}>{topError}</span>}

      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={pending}>
          {pending ? "Saving…" : "Continue"}
        </button>
      </div>
    </form>
  );
}

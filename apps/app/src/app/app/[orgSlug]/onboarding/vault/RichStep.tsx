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

function readArr(v: unknown, n: number): string[] {
  if (Array.isArray(v)) {
    const out = v.map(String);
    while (out.length < n) out.push("");
    return out.slice(0, n);
  }
  return Array(n).fill("");
}

export function RichStep({ orgId, orgSlug, initial }: Props) {
  const router = useRouter();
  const [cadence, setCadence] = useState<string[]>(readArr(initial?.cadenceExamples, 3));
  const [samples, setSamples] = useState<string[]>(readArr(initial?.samplePosts, 3));
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
        stage: "rich",
        answers: {
          cadenceExamples: cadence.filter(Boolean),
          samplePosts: samples.filter(Boolean),
        },
      });
      if (!res.ok) {
        if ("fieldErrors" in res && res.fieldErrors) setErrors(res.fieldErrors);
        setTopError(res.error);
        return;
      }
      router.push(`/app/${orgSlug}`);
    });
  }

  function setCad(i: number, v: string) {
    setCadence((prev) => prev.map((x, idx) => (idx === i ? v : x)));
  }
  function setSample(i: number, v: string) {
    setSamples((prev) => prev.map((x, idx) => (idx === i ? v : x)));
  }
  function addSample() {
    setSamples((prev) => (prev.length < 5 ? [...prev, ""] : prev));
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <fieldset className={styles.field}>
        <legend className={styles.label}>Three cadence examples</legend>
        <span className={styles.hint}>Short snippets that show your rhythm.</span>
        {cadence.map((v, i) => (
          <textarea key={i} className={styles.textarea} value={v} onChange={(e) => setCad(i, e.target.value)} />
        ))}
        {errors.cadenceExamples && <span className={styles.error}>{errors.cadenceExamples}</span>}
      </fieldset>

      <fieldset className={styles.field}>
        <legend className={styles.label}>3-5 sample posts</legend>
        <span className={styles.hint}>Paste full text. These become voice anchors.</span>
        {samples.map((v, i) => (
          <textarea key={i} className={styles.textarea} value={v} onChange={(e) => setSample(i, e.target.value)} />
        ))}
        {samples.length < 5 && (
          <button type="button" className={styles.skip} onClick={addSample}>
            + add another
          </button>
        )}
        {errors.samplePosts && <span className={styles.error}>{errors.samplePosts}</span>}
      </fieldset>

      {topError && <span className={styles.error}>{topError}</span>}

      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={pending}>
          {pending ? "Saving…" : "Finish setup"}
        </button>
        <button
          type="button"
          className={styles.skip}
          onClick={() => router.push(`/app/${orgSlug}`)}
        >
          Skip for now
        </button>
      </div>
    </form>
  );
}

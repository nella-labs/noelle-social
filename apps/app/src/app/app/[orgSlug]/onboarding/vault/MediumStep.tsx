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

function readTags(v: unknown): string {
  return Array.isArray(v) ? v.map(String).join(", ") : "";
}

export function MediumStep({ orgId, orgSlug, initial }: Props) {
  const router = useRouter();
  const [voiceDos, setVoiceDos] = useState<string[]>(readArr(initial?.voiceDos, 3));
  const [voiceDonts, setVoiceDonts] = useState<string[]>(readArr(initial?.voiceDonts, 3));
  const [bannedPhrasesRaw, setBannedPhrasesRaw] = useState<string>(readTags(initial?.bannedPhrases));
  const [pillarsRaw, setPillarsRaw] = useState<string>(readTags(initial?.contentPillars));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function parseTags(raw: string): string[] {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setTopError(null);
    startTransition(async () => {
      const res = await submitVaultStage({
        orgId,
        orgSlug,
        stage: "medium",
        answers: {
          voiceDos: voiceDos.filter(Boolean),
          voiceDonts: voiceDonts.filter(Boolean),
          bannedPhrases: parseTags(bannedPhrasesRaw),
          contentPillars: parseTags(pillarsRaw),
        },
      });
      if (!res.ok) {
        if ("fieldErrors" in res && res.fieldErrors) setErrors(res.fieldErrors);
        setTopError(res.error);
        return;
      }
      router.push(`/app/${orgSlug}/onboarding/vault?step=rich`);
    });
  }

  function setDo(i: number, v: string) {
    setVoiceDos((prev) => prev.map((x, idx) => (idx === i ? v : x)));
  }
  function setDont(i: number, v: string) {
    setVoiceDonts((prev) => prev.map((x, idx) => (idx === i ? v : x)));
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <fieldset className={styles.field}>
        <legend className={styles.label}>Three voice rules — do</legend>
        {voiceDos.map((v, i) => (
          <input
            key={i}
            className={styles.input}
            value={v}
            onChange={(e) => setDo(i, e.target.value)}
            placeholder={["Direct.", "Specific numbers.", "Honest uncertainty."][i]}
          />
        ))}
        {errors.voiceDos && <span className={styles.error}>{errors.voiceDos}</span>}
      </fieldset>

      <fieldset className={styles.field}>
        <legend className={styles.label}>Three voice rules — don't</legend>
        {voiceDonts.map((v, i) => (
          <input
            key={i}
            className={styles.input}
            value={v}
            onChange={(e) => setDont(i, e.target.value)}
            placeholder={["No hype.", "No fake certainty.", "No 'excited to announce'."][i]}
          />
        ))}
        {errors.voiceDonts && <span className={styles.error}>{errors.voiceDonts}</span>}
      </fieldset>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="banned">Banned phrases (comma-separated)</label>
        <input id="banned" className={styles.input} value={bannedPhrasesRaw} onChange={(e) => setBannedPhrasesRaw(e.target.value)} placeholder="simply, leverage, unlock" />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="pillars">Content pillars (3-5, comma-separated)</label>
        <input id="pillars" className={styles.input} value={pillarsRaw} onChange={(e) => setPillarsRaw(e.target.value)} placeholder="building, founder-life, technical" />
        {errors.contentPillars && <span className={styles.error}>{errors.contentPillars}</span>}
      </div>

      {topError && <span className={styles.error}>{topError}</span>}

      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={pending}>
          {pending ? "Saving…" : "Continue"}
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

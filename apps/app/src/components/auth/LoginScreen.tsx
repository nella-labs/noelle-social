"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, Mail } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { PublicShell } from "@/components/public/PublicShell";
import styles from "./login.module.css";

type Provider = "google" | "github";
type Status = { kind: "idle" } | { kind: "busy" } | { kind: "sent"; email: string } | { kind: "error"; message: string };

export function LoginScreen({ errorMessage }: { errorMessage?: string | null }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const busy = status.kind === "busy";

  async function handleMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    setStatus({ kind: "busy" });
    try {
      const { error } = await createSupabaseBrowserClient().auth.signInWithOtp({
        email: address,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      setStatus(error ? { kind: "error", message: error.message } : { kind: "sent", email: address });
    } catch {
      setStatus({ kind: "error", message: "Sign-in is unavailable. Try again in a moment." });
    }
  }

  async function handleOAuth(provider: Provider) {
    setStatus({ kind: "busy" });
    try {
      const { error } = await createSupabaseBrowserClient().auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) setStatus({ kind: "error", message: error.message });
    } catch {
      setStatus({ kind: "error", message: "Sign-in is unavailable. Try again in a moment." });
    }
  }

  return (
    <PublicShell>
      <main className={styles.main}>
        <section className={styles.intro}>
          <span className={styles.kicker}>SOCIAL GROWTH, WITH INTENT</span>
          <h1>More useful conversations.<br /><em>More room to grow.</em></h1>
          <p>Turn your voice into content, find people worth engaging with, and learn from what you publish.</p>
          <div className={styles.workflow} aria-label="Growth workflow">
            {['Discover', 'Create', 'Review', 'Learn'].map((step, index) => <span key={step}><b>{String(index + 1).padStart(2, '0')}</b>{step}</span>)}
          </div>
        </section>
        <section className={styles.panel} aria-labelledby="sign-in-title">
          {status.kind === "sent" ? (
            <>
              <Mail className={styles.mail} size={30} aria-hidden="true" />
              <h2 id="sign-in-title">Check your inbox</h2>
              <p role="status">We sent a sign-in link to <strong>{status.email}</strong>.</p>
              <button className="btn" onClick={() => setStatus({ kind: "idle" })}>Use a different email</button>
            </>
          ) : (
            <>
              <h2 id="sign-in-title">Your growth workspace</h2>
              <p>Sign in to pick up where you left off.</p>
              {errorMessage ? <p className={styles.error} role="alert">{errorMessage}</p> : null}
              <form onSubmit={handleMagicLink} className={styles.form}>
                <label htmlFor="sign-in-email">Email address</label>
                <input id="sign-in-email" className="input" type="email" autoComplete="email" required disabled={busy} placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} />
                <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Connecting…" : "Send sign-in link"}<ArrowRight size={15} aria-hidden="true" /></button>
              </form>
              <div className={styles.divider}>or continue with</div>
              <div className={styles.providers}>
                <button className="btn" disabled={busy} onClick={() => handleOAuth("github")}>GitHub</button>
                <button className="btn" disabled={busy} onClick={() => handleOAuth("google")}>Google</button>
              </div>
              {status.kind === "error" ? <p className={styles.error} role="alert">{status.message}</p> : null}
            </>
          )}
          <Link href="/about" className={styles.selfHost}>Open source. Make the workspace your own.</Link>
        </section>
      </main>
    </PublicShell>
  );
}

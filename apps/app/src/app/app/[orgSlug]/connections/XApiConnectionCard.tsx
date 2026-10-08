"use client";

import { useState, useTransition } from "react";
import styles from "./connections.module.css";
import type { XApiConnection } from "@/lib/queries";
import { saveXApiCredsAction, disconnectXApiAction } from "./x-api-actions";

/**
 * X API connection card — Vega's OAuth 1.0a creds (from X's Keys & Tokens page).
 * DB-backed + hot-swappable, so you can replace them anytime. On save, Vega's
 * X-API posting is enabled; disconnect turns it off. Draft-only agents are never
 * affected.
 */
export function XApiConnectionCard({ orgSlug, connection }: { orgSlug: string; connection: XApiConnection }) {
  const [editing, setEditing] = useState(!connection.connected);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [f, setF] = useState({
    consumerKey: "",
    consumerSecret: "",
    accessToken: "",
    accessTokenSecret: "",
    handle: connection.handle ?? "",
  });

  const ready = f.consumerKey && f.consumerSecret && f.accessToken && f.accessTokenSecret;

  function save() {
    if (!ready) return;
    setMsg(null);
    start(async () => {
      try {
        const out = await saveXApiCredsAction(orgSlug, {
          consumerKey: f.consumerKey.trim(),
          consumerSecret: f.consumerSecret.trim(),
          accessToken: f.accessToken.trim(),
          accessTokenSecret: f.accessTokenSecret.trim(),
          handle: f.handle.trim() || undefined,
        });
        setMsg({ ok: true, text: `Connected${out.handle ? ` as @${out.handle}` : ""}. Vega can now post via the X API.` });
        setEditing(false);
      } catch (e) {
        setMsg({ ok: false, text: `Couldn't save: ${(e as Error).message}` });
      }
    });
  }

  function disconnect() {
    start(async () => {
      await disconnectXApiAction(orgSlug);
      setMsg({ ok: true, text: "Disconnected. Vega's X-API posting is off." });
      setEditing(true);
    });
  }

  if (!connection.hasVega) {
    return (
      <div className="card" style={{ opacity: 0.8 }}>
        <div className="card-h"><h3>X API · posting</h3><span className="tag">no Vega</span></div>
        <div style={{ color: "var(--ink-muted)", fontSize: 13 }}>Hire the X Growth Intern (Vega) to connect an X account for auto-posting.</div>
      </div>
    );
  }

  return (
    <div className={`card ${styles.postingCard}`}>
      <div className="card-h">
        <h3>X API · posting</h3>
        {connection.connected ? (
          <span className="tag tag-ok"><span className="dot dot-ok" /> connected{connection.handle ? ` · @${connection.handle}` : ""}</span>
        ) : (
          <span className="tag">not set</span>
        )}
      </div>
      <div style={{ color: "var(--ink-muted)", fontSize: 12.5, marginBottom: 14, maxWidth: "56ch" }}>
        Vega&apos;s OAuth 1.0a keys from X&apos;s <strong>Keys &amp; Tokens</strong> page (Consumer Key/Secret + Access
        Token/Secret). Stored in the DB, hot-swappable, never logged. Draft-only agents are never affected.
      </div>

      {connection.connected && !editing ? (
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)} disabled={pending}>Replace credentials</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={disconnect} disabled={pending}>Disconnect</button>
        </div>
      ) : (
        <div className={styles.postingForm}>
          <Field label="Consumer Key (API Key)" value={f.consumerKey} onChange={(v) => setF({ ...f, consumerKey: v })} secret={false} />
          <Field label="Consumer Secret" value={f.consumerSecret} onChange={(v) => setF({ ...f, consumerSecret: v })} secret />
          <Field label="Access Token" value={f.accessToken} onChange={(v) => setF({ ...f, accessToken: v })} secret={false} />
          <Field label="Access Token Secret" value={f.accessTokenSecret} onChange={(v) => setF({ ...f, accessTokenSecret: v })} secret />
          <Field label="Handle (optional)" value={f.handle} onChange={(v) => setF({ ...f, handle: v })} secret={false} placeholder="rcmisk" />
          <div className={styles.postingActions}>
            <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={!ready || pending}>
              {pending ? "Saving…" : "Save & enable posting"}
            </button>
            {connection.connected ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)} disabled={pending}>Cancel</button>
            ) : null}
          </div>
        </div>
      )}

      {msg ? (
        <div style={{ marginTop: 12, fontSize: 12.5, color: msg.ok ? "var(--ok)" : "var(--bad, oklch(0.6 0.18 25))" }}>{msg.text}</div>
      ) : null}
    </div>
  );
}

function Field({ label, value, onChange, secret, placeholder }: { label: string; value: string; onChange: (v: string) => void; secret: boolean; placeholder?: string }) {
  return (
    <label className={styles.postingField}>
      <span>{label}</span>
      <input type={secret ? "password" : "text"} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} />
    </label>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createCodeInvitations,
  createEmailInvitation,
  revokeInvitation,
} from "@/app/app/[orgSlug]/admin/invitations/actions";
import type { Invitation, InvitationStatus } from "@/lib/invitations";

interface Props {
  invitations: Invitation[];
  canManage: boolean;
  listmonkConfigured: boolean;
}

const STATUS_TONE: Record<InvitationStatus, string> = {
  pending: "var(--info, #4a6fa5)",
  redeemed: "var(--ok)",
  revoked: "var(--ink-muted)",
};

export function InvitationsManager({ invitations, canManage, listmonkConfigured }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [freshCodes, setFreshCodes] = useState<string[]>([]);

  // Email-invite form
  const [email, setEmail] = useState("");
  const [emailNote, setEmailNote] = useState("");

  // Loose-code form
  const [count, setCount] = useState(1);
  const [codeNote, setCodeNote] = useState("");

  const sendEmailInvite = () => {
    setNotice(null);
    setFreshCodes([]);
    startTransition(async () => {
      const r = await createEmailInvitation({ email, note: emailNote || undefined });
      if (!r.ok) {
        setNotice({ tone: "err", text: r.error });
        return;
      }
      setEmail("");
      setEmailNote("");
      setNotice({
        tone: "ok",
        text: r.emailSent
          ? `Invite sent. Code ${r.code} is bound to that email.`
          : `Invite created (code ${r.code}), but email wasn't sent — Listmonk isn't configured here.`,
      });
      router.refresh();
    });
  };

  const generateCodes = () => {
    setNotice(null);
    setFreshCodes([]);
    startTransition(async () => {
      const r = await createCodeInvitations({ count, note: codeNote || undefined });
      if (!r.ok) {
        setNotice({ tone: "err", text: r.error });
        return;
      }
      setCodeNote("");
      setFreshCodes(r.codes);
      setNotice({ tone: "ok", text: `Generated ${r.codes.length} code${r.codes.length === 1 ? "" : "s"}.` });
      router.refresh();
    });
  };

  const revoke = (id: string) => {
    setNotice(null);
    startTransition(async () => {
      const r = await revokeInvitation({ id });
      if (!r.ok) {
        setNotice({ tone: "err", text: r.error ?? "Revoke failed." });
        return;
      }
      router.refresh();
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {canManage ? (
        <div className="stack-phone" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, alignItems: "start" }}>
          <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="eyebrow">Invite by email</div>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-muted)" }}>
              Adds them to the sign-in allowlist and emails an invite link. They skip the code
              step automatically when they sign in with this address.
            </p>
            {!listmonkConfigured ? (
              <p style={{ margin: 0, fontSize: 12, color: "var(--warn)" }}>
                Listmonk isn&apos;t configured here — the invite will be created but no email is sent.
              </p>
            ) : null}
            <Field label="Email">
              <TextInput value={email} onChange={setEmail} placeholder="founder@acme.com" type="email" />
            </Field>
            <Field label="Note" hint="Optional — for your eyes only.">
              <TextInput value={emailNote} onChange={setEmailNote} placeholder="met at YC dinner" />
            </Field>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              style={{ width: "100%" }}
              disabled={pending || !email.trim()}
              onClick={sendEmailInvite}
            >
              {pending ? "Working…" : "Send invite →"}
            </button>
          </div>

          <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="eyebrow">Generate shareable codes</div>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-muted)" }}>
              Loose codes not tied to an email. Anyone who can sign in can redeem one to create an org.
            </p>
            <Field label="How many" hint="1–25.">
              <TextInput
                value={String(count)}
                onChange={(v) => setCount(Math.max(1, Math.min(25, Number(v.replace(/\D/g, "")) || 1)))}
                placeholder="1"
                type="number"
              />
            </Field>
            <Field label="Note" hint="Optional — applied to all codes in this batch.">
              <TextInput value={codeNote} onChange={setCodeNote} placeholder="launch tweet" />
            </Field>
            <button
              type="button"
              className="btn btn-sm"
              style={{ width: "100%" }}
              disabled={pending}
              onClick={generateCodes}
            >
              {pending ? "Working…" : `Generate ${count} code${count === 1 ? "" : "s"} →`}
            </button>
          </div>
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-muted)" }}>
          You can view invitations. Generating and revoking is owner-only.
        </p>
      )}

      {notice ? (
        <div
          className="card"
          style={{
            padding: 14,
            fontSize: 12.5,
            color: notice.tone === "ok" ? "var(--ok)" : "var(--danger)",
            boxShadow: notice.tone === "err" ? "0 0 0 0.5px var(--danger)" : undefined,
          }}
        >
          {notice.text}
        </div>
      ) : null}

      {freshCodes.length > 0 ? (
        <div className="card" style={{ padding: 16 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>New codes — copy them now</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {freshCodes.map((c) => (
              <CopyChip key={c} code={c} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div
          className="hide-phone"
          style={{
            display: "grid",
            gridTemplateColumns: "160px 1fr 90px 110px 1fr 90px",
            gap: 14,
            padding: "10px 18px",
            background: "var(--paper-2)",
            fontFamily: "var(--mono)",
            fontSize: 10.5,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--ink-muted)",
            borderBottom: "1px solid var(--rule)",
          }}
        >
          <span>Code</span>
          <span>Email / note</span>
          <span>Kind</span>
          <span>Status</span>
          <span>Created · redeemed</span>
          <span style={{ textAlign: "right" }}>{canManage ? "Action" : ""}</span>
        </div>

        {invitations.length === 0 ? (
          <div style={{ padding: "18px", fontSize: 13, color: "var(--ink-muted)" }}>
            No invitations yet.
          </div>
        ) : (
          invitations.map((inv, i) => (
            <div
              key={inv.id}
              className="stack-phone"
              style={{
                display: "grid",
                gridTemplateColumns: "160px 1fr 90px 110px 1fr 90px",
                gap: 14,
                alignItems: "center",
                padding: "12px 18px",
                borderTop: i === 0 ? 0 : "1px solid var(--rule-soft)",
              }}
            >
              <CopyChip code={inv.code} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {inv.email ?? <span style={{ color: "var(--ink-muted)" }}>—</span>}
                </div>
                {inv.note ? (
                  <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>{inv.note}</div>
                ) : null}
              </div>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-muted)" }}>
                {inv.kind}
              </span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontFamily: "var(--mono)",
                  fontSize: 10.5,
                  color: STATUS_TONE[inv.status],
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: STATUS_TONE[inv.status] }} />
                {inv.status}
              </span>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                {fmtDate(inv.created_at)}
                {inv.redeemed_at ? ` · ${fmtDate(inv.redeemed_at)}` : ""}
              </span>
              <span style={{ textAlign: "right" }}>
                {canManage && inv.status === "pending" ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={pending}
                    onClick={() => revoke(inv.id)}
                  >
                    Revoke
                  </button>
                ) : null}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // Pin locale + timezone so the server (UTC) and client render identically —
  // a locale/timezone-dependent date in render otherwise aborts hydration.
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function CopyChip({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(code).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
      title="Copy code"
      style={{
        fontFamily: "var(--mono)",
        fontSize: 11.5,
        color: copied ? "var(--ok)" : "var(--ink-2)",
        background: "var(--paper-2)",
        border: 0,
        boxShadow: "0 0 0 0.5px var(--rule)",
        borderRadius: 6,
        padding: "4px 8px",
        cursor: "pointer",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {copied ? "copied!" : code}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-muted)",
        }}
      >
        {label}
      </span>
      {children}
      {hint ? <span style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>{hint}</span> : null}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      type={type}
      style={{
        height: 36,
        padding: "0 12px",
        borderRadius: 8,
        border: 0,
        boxShadow: "0 0 0 0.5px var(--rule)",
        background: "var(--paper-2)",
        color: "var(--ink)",
        fontFamily: "var(--body)",
        fontSize: 13,
        outline: "none",
        width: "100%",
      }}
    />
  );
}

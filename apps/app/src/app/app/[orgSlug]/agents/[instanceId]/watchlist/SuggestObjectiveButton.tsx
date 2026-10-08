"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { suggestVideoObjective } from "../video-watchlist-actions";
import { updateObjective } from "@/lib/agent-targeting";

// "Suggest from my account" — drafts a Nova objective from the operator's own
// tracked IG/TikTok content (their account Brand Guide + post captions), shown
// for review before it's saved. Answers "pull from my Instagram and figure out
// what I'm about" without making the operator type the objective by hand.

const ERRORS: Record<string, string> = {
  no_account_data: "Nova hasn't tracked your account yet — add your own handle on the watchlist, then try again.",
  empty: "Couldn't draft one from your account — try again.",
  forbidden: "Not allowed.",
  not_found: "Agent not found.",
  unauthenticated: "Please sign in again.",
};

export function SuggestObjectiveButton({ orgSlug, instanceId }: { orgSlug: string; instanceId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function suggest() {
    setErr(null);
    setDraft(null);
    start(async () => {
      const res = await suggestVideoObjective({ orgSlug, instanceId });
      if (res.ok) setDraft(res.objective);
      else setErr(ERRORS[res.error] ?? "Couldn't draft an objective.");
    });
  }

  function use() {
    if (!draft) return;
    setSaving(true);
    start(async () => {
      const res = await updateObjective({ orgSlug, instanceId, objective: draft });
      setSaving(false);
      if (res.ok) {
        setDraft(null);
        router.refresh();
      } else {
        setErr("Couldn't save — try again.");
      }
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
      <button type="button" className="btn btn-xs" onClick={suggest} disabled={pending} title="Draft an objective from your own tracked posts">
        {pending && !saving ? "Reading your account…" : "✨ Suggest from my account"}
      </button>
      {err ? (
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, maxWidth: 260, textAlign: "right", color: "var(--rust, #b4541f)" }}>{err}</span>
      ) : null}
      {draft ? (
        <div className="card" style={{ padding: 12, maxWidth: 340, textAlign: "left" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-soft)", marginBottom: 6 }}>
            Suggested objective
          </div>
          <p style={{ fontSize: 13, lineHeight: 1.45, margin: 0, color: "var(--ink)" }}>{draft}</p>
          <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
            <button type="button" className="btn btn-xs btn-ghost" onClick={() => setDraft(null)} disabled={saving}>Dismiss</button>
            <button type="button" className="btn btn-xs btn-accent" onClick={use} disabled={saving}>{saving ? "Saving…" : "Use this"}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

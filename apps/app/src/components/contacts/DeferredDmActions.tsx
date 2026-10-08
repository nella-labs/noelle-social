"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CopyButton } from "@/components/approvals/CopyButton";
import { buildXDmUrl } from "@/lib/x-dm-url";
import { markSentManual } from "@/app/app/[orgSlug]/approvals/actions";

/**
 * Actions for a DM parked on the person's Contacts page ("Wait for reply").
 * Once the person replies on X, the operator opens the X DM composer
 * pre-filled (one click, logged-in session), sends it, then clicks
 * "Mark DM sent" — which records the approval as sent (DMs are hand-dispatched;
 * X has no DM-send API here).
 */
export function DeferredDmActions({
  orgSlug,
  approvalId,
  body,
  recipientId,
}: {
  orgSlug: string;
  approvalId: string;
  body: string;
  recipientId?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const markSent = () => {
    if (pending) return;
    setError(null);
    start(async () => {
      const res = await markSentManual({ orgSlug, approvalId });
      if (res.ok) router.refresh();
      else setError(res.error.message || "Couldn't mark sent — retry");
    });
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 8 }}>
      <CopyButton text={body} label="Copy DM" />
      <a
        href={buildXDmUrl(recipientId, body)}
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-xs"
        style={{ background: "var(--danger)", color: "#fff", borderColor: "var(--danger)", textDecoration: "none" }}
        title="Open the X DM composer. Mark DM sent after you send it."
      >
        Open DM in X ↗
      </a>
      <button
        type="button"
        className="btn btn-xs btn-ghost"
        onClick={markSent}
        disabled={pending}
      >
        {pending ? "Marking…" : "✓ Mark DM sent"}
      </button>
      {error ? (
        <span className="tag" style={{ color: "var(--danger)", fontSize: 11 }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

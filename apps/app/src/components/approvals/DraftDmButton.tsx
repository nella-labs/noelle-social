"use client";

import * as React from "react";
import {
  requestDmForLead,
  type RequestDmForLeadResult,
} from "@/app/app/[orgSlug]/approvals/dm-request-actions";

/**
 * "Draft DM" — a per-post button in the Lyra approvals inbox. Flags the lead
 * behind this post for a DM; Lyra drafts the NEXT rung of the progressive ladder
 * (Open → Deepen → Bridge → Invite, chosen by how many DMs were already sent to
 * this person) and queues it for approval. Never auto-sent. The DM lands in the
 * inbox under the "DMs: on" toggle.
 */
interface Props {
  orgSlug: string;
  approvalId: string;
}

export function DraftDmButton({ orgSlug, approvalId }: Props) {
  const [state, setState] = React.useState<"idle" | "pending" | "queued" | "error">("idle");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [, startTransition] = React.useTransition();

  const onClick = () => {
    setState("pending");
    setMsg(null);
    startTransition(async () => {
      const res: RequestDmForLeadResult = await requestDmForLead({ orgSlug, approvalId });
      if (res.ok) {
        setState("queued");
      } else {
        setState("error");
        setMsg(res.error === "no_post" ? "No post to base a DM on" : "Couldn't request — try again");
      }
    });
  };

  if (state === "queued") {
    return (
      <span
        className="btn btn-sm btn-ghost"
        aria-disabled="true"
        style={{ color: "var(--accent)", cursor: "default", opacity: 0.85 }}
        title="Lyra is drafting the next DM — it lands in Approvals (toggle DMs on)"
      >
        ✓ DM queued
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={onClick}
        disabled={state === "pending"}
        title="Draft the next DM to this person — Lyra warms up over a few messages toward a call, never pushy. Queued for approval, never auto-sent."
      >
        {state === "pending" ? "Drafting…" : "Draft DM"}
      </button>
      {msg ? (
        <span className="tag" style={{ color: "var(--danger)", fontSize: 11 }}>
          {msg}
        </span>
      ) : null}
    </>
  );
}

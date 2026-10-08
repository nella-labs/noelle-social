"use client";

import * as React from "react";
import {
  requestDmForPerson,
  type RequestDmResult,
} from "@/app/app/[orgSlug]/contacts/contacts-actions";

/**
 * On-demand DM trigger for a contact. Flags the person's most recent
 * lead-with-a-post for a one-off DM; the owning agent's drafter (Vega/Lyra)
 * generates it next tick and queues it for approval (auto-DM stays off). The
 * DM lands in the Approvals inbox (toggle "DMs: on" to see it).
 */
interface Props {
  orgSlug: string;
  personId: string;
}

export function GenerateDmButton({ orgSlug, personId }: Props) {
  const [state, setState] = React.useState<
    "idle" | "pending" | "queued" | "error"
  >("idle");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [, startTransition] = React.useTransition();

  const onClick = () => {
    setState("pending");
    setMsg(null);
    startTransition(async () => {
      const res: RequestDmResult = await requestDmForPerson({
        orgSlug,
        personId,
      });
      if (res.ok) {
        setState("queued");
      } else {
        setState("error");
        setMsg(
          res.error === "no_post"
            ? "No recent post to base a DM on yet"
            : "Couldn't request — try again",
        );
      }
    });
  };

  if (state === "queued") {
    return (
      <span
        className="btn btn-sm"
        aria-disabled="true"
        style={{ color: "var(--accent)", cursor: "default", opacity: 0.85 }}
        title="The agent is drafting a DM — it lands in Approvals (toggle DMs on)"
      >
        ✓ DM requested — check Approvals shortly
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="btn btn-sm"
        onClick={onClick}
        disabled={state === "pending"}
        title="Draft a one-off DM for this person — the agent generates it and queues it for approval"
      >
        {state === "pending" ? "Requesting…" : "Generate DM →"}
      </button>
      {msg ? (
        <span className="tag" style={{ color: "var(--danger)", fontSize: 11 }}>
          {msg}
        </span>
      ) : null}
    </span>
  );
}

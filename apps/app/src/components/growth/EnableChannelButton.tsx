"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { hireAgent } from "@/app/app/[orgSlug]/actions";
import type { AgentRole } from "@/lib/db-types";

export function EnableChannelButton({ orgSlug, role, label }: { orgSlug: string; role: AgentRole; label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return <div>
    <button className="btn btn-primary btn-sm" disabled={pending} onClick={() => startTransition(async () => {
      setError(null);
      try { await hireAgent({ orgSlug, role }); router.refresh(); }
      catch { setError("Could not set up this channel. Try again."); }
    })}>{pending ? "Setting up…" : `Set up ${label}`}</button>
    {error && <p className="danger" role="alert">{error}</p>}
  </div>;
}

"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setGuidedSetupDismissed } from "@/app/app/[orgSlug]/onboarding/actions";

interface Props {
  orgSlug: string;
  dismissed: boolean;
  label: string;
}

/**
 * The one interactive bit of the guided panel. Everything else is a server
 * component, so setup state never round-trips through client JS.
 */
export function DismissGuided({ orgSlug, dismissed, label }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        className="guided-dismiss"
        disabled={pending}
        onClick={() => {
          if (busy.current) return;
          busy.current = true;
          setError(null);
          startTransition(async () => {
            try {
              const result = await setGuidedSetupDismissed({ orgSlug, dismissed: !dismissed });
              if (!result.ok) {
                setError("Could not update setup visibility. Try again.");
                return;
              }
              router.refresh();
            } catch {
              setError("Could not update setup visibility. Try again.");
            } finally {
              busy.current = false;
            }
          });
        }}
      >
        {pending ? "Saving…" : label}
      </button>
      {error ? <p className="guided-step-reason" role="alert">{error}</p> : null}
    </div>
  );
}

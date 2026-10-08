"use client";

import { useEffect } from "react";
import { ErrorScreen } from "@/components/error-screen";

/**
 * Error boundary for the agent detail route.
 *
 * Without this, an uncaught throw in the page's server render (e.g. a transient
 * Cloud SQL connection failure) propagates to the root boundary and the WHOLE
 * page renders blank — no message, no retry, and in production the real error
 * is redacted to a digest. That turns a 30-second DB blip into an opaque
 * outage. This boundary keeps the org nav shell intact, shows a retry, and
 * surfaces the digest so the failing request is greppable in the runtime logs.
 *
 * It reuses the shared `ErrorScreen` panel (`embedded`, since it renders inside
 * the org layout's content column) rather than a one-off card.
 */
export default function AgentDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The full message is redacted in prod; the digest maps to the server log.
    console.error("Agent detail render failed:", error.digest, error);
  }, [error]);

  return (
    <ErrorScreen
      kind="500"
      embedded
      primaryAction={{ label: "Retry", onClick: reset }}
      traceId={error.digest}
    />
  );
}

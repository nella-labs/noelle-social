"use client";

import { useEffect } from "react";
import { ErrorScreen } from "@/components/error-screen";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[noelle-app]", error);
  }, [error]);

  return (
    <ErrorScreen
      kind="500"
      primaryAction={{ label: "Retry the request", onClick: reset }}
      secondaryAction={{
        label: "Open status page",
        href: "https://status.trynoelle.com",
      }}
      traceId={error.digest}
    />
  );
}

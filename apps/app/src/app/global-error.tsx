"use client";

import { useEffect } from "react";

/**
 * Root-level last-resort error boundary.
 *
 * Next renders this ONLY when an error escapes every nested boundary — i.e. a
 * throw in the root layout itself, or in another error boundary. It replaces the
 * whole document, so it must ship its own <html>/<body> and cannot rely on the
 * theme bootstrap or globals.css (those live in the root layout it's replacing)
 * — hence the self-contained inline styles.
 *
 * Why it exists: without it, an uncaught root-level error renders a completely
 * BLANK white page (no markup, no message) — the worst possible failure. This
 * guarantees the user always gets a message + a recovery action. The dashboard
 * boundary (app/app/error.tsx) still handles the common case (a transient DB
 * blip in the org layout) with the nicer themed Retry card; this is the floor
 * beneath it.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Root render failed:", error.digest, error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#F2F4F5",
          color: "#172124",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          padding: 24,
        }}
      >
        <main
          style={{
            maxWidth: 460,
            textAlign: "center",
            background: "#FFFFFF",
            border: "0.5px solid rgba(0,0,0,0.12)",
            borderRadius: 22,
            padding: "40px 28px",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}
        >
          <h1 style={{ fontSize: 20, margin: "0 0 8px", fontWeight: 600 }}>
            Something went wrong
          </h1>
          <p
            style={{
              fontSize: 14,
              lineHeight: 1.5,
              color: "#617278",
              margin: "0 0 20px",
            }}
          >
            The app hit an unexpected error — usually a brief, transient blip.
            Reloading almost always fixes it.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              appearance: "none",
              border: "none",
              borderRadius: 999,
              padding: "9px 18px",
              fontSize: 14,
              fontWeight: 500,
              color: "#FFFFFF",
              background: "#087F8C",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
          {error.digest ? (
            <div
              style={{
                marginTop: 16,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 11,
                color: "#7C8B90",
              }}
            >
              ref: {error.digest}
            </div>
          ) : null}
        </main>
      </body>
    </html>
  );
}

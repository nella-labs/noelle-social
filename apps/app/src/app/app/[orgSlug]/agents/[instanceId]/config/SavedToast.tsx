"use client";

import { useEffect, useState } from "react";

/**
 * Save-confirmation banner for the agent config form.
 *
 * The server action used to `redirect()` away from /config on save, so
 * the user landed on the agent detail page with no visible confirmation
 * — they read that as "the save button does nothing." Now the action
 * stays on /config and appends ?saved=<timestamp>; this banner mounts
 * when that param is present, fades after 3.5s, and is keyed by the
 * timestamp so consecutive saves each re-trigger the show animation.
 */
export function SavedToast({ token }: { token: string | null }) {
  const [visible, setVisible] = useState<boolean>(!!token);

  useEffect(() => {
    if (!token) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 3500);
    return () => clearTimeout(t);
  }, [token]);

  if (!token || !visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 24,
        right: 24,
        zIndex: 50,
        padding: "10px 14px",
        background: "var(--paper)",
        color: "var(--ink)",
        boxShadow:
          "0 0 0 0.5px var(--rule), 0 6px 20px rgba(0,0,0,0.08)",
        borderRadius: 10,
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 13,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: "var(--accent)",
          display: "inline-block",
        }}
      />
      <span>Saved. Workers will pick this up on the next tick.</span>
    </div>
  );
}

"use client";

import * as React from "react";

/**
 * The app's one clipboard affordance. Tracks WHICH item was last copied
 * (`copiedKey`) so a list can flash "Copied ✓" on just the row that was
 * clicked, and auto-clears after `resetMs`. Single-button callers can treat any
 * non-null `copiedKey` as "copied".
 *
 * Returns success only after the clipboard write completes. Failed writes
 * leave the item uncopied and expose feedback for manual selection.
 */
export function useCopy(resetMs = 1600) {
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const [copyError, setCopyError] = React.useState<string | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = React.useRef(0);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = React.useCallback(
    async (text: string, key = "__single__"): Promise<boolean> => {
      const current = ++attempt.current;
      if (timer.current) clearTimeout(timer.current);
      setCopiedKey(null);
      setCopyError(null);
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(text);
        if (mounted.current && current === attempt.current) {
          setCopiedKey(key);
          timer.current = setTimeout(() => setCopiedKey(null), resetMs);
        }
        return true;
      } catch {
        if (mounted.current && current === attempt.current)
          setCopyError("Couldn't copy — select the text and copy manually.");
        return false;
      }
    },
    [resetMs],
  );

  return { copiedKey, copy, copyError };
}

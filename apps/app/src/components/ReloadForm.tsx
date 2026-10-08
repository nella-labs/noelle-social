"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * A <form> whose server action is followed by a FULL document reload.
 *
 * Why not router.refresh() / revalidatePath(): this app runs React 19.1.x +
 * Next 15.5, which has the fast-action reconciler race (React PR #35518 — not
 * yet in a Next-15.5-compatible stable; bumping React to 19.2.x breaks the
 * client). The race wedges React's reconciler after the FIRST quick server
 * action, so a soft refresh updates once and then every later action is dead
 * until the tree is torn down by a full reload. A hard reload recreates React
 * each time, so every mutation reliably reflects. The brief reload flash is the
 * cost of dodging the race without a risky React/Next upgrade. Remove this once
 * React/Next ship the fix together.
 */
export function ReloadForm({
  action,
  children,
  className,
  style,
}: {
  /** A server action. Invoked, then the page hard-reloads to show the result. */
  action: (formData: FormData) => Promise<unknown> | unknown;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <form
      className={className}
      style={style}
      action={async (formData: FormData) => {
        await action(formData);
        window.location.reload();
      }}
    >
      {children}
    </form>
  );
}

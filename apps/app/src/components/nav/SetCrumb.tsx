"use client";

import { useSetCrumb } from "./crumbs-context";

/**
 * Mount inside a page to replace one breadcrumb segment in `OrgCrumbs`
 * with a friendlier label. Server pages can render this directly with
 * the page's already-resolved data (e.g. agent display name).
 */
export function SetCrumb({ segment, label }: { segment: string; label: string }) {
  useSetCrumb(segment, label);
  return null;
}

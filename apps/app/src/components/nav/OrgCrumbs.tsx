"use client";

import { usePathname } from "next/navigation";
import { Topbar, type Crumb } from "./Topbar";
import { useCrumbOverrides } from "./crumbs-context";

interface OrgCrumbsProps {
  orgSlug: string;
  orgName: string;
}

/**
 * Auto-derive breadcrumbs from the current pathname for the
 * `/app/{orgSlug}/...` shell. Keeps the route-aware Topbar a
 * pure client component so the org layout can stay server-rendered.
 */
export function OrgCrumbs({ orgSlug, orgName }: OrgCrumbsProps) {
  const pathname = usePathname() ?? "";
  const overrides = useCrumbOverrides();
  const base = `/app/${orgSlug}`;
  const after = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\//, "") : "";
  const parts = after.split("/").filter(Boolean);

  const crumbs: Crumb[] = [{ label: orgName, href: base }];
  const trail: string[] = [];
  for (const p of parts) {
    trail.push(p);
    const label = overrides[p] ?? labelFor(p, trail);
    crumbs.push({ label, href: `${base}/${trail.join("/")}` });
  }
  // Last crumb shouldn't be a link (handled in <Topbar/>).
  if (crumbs.length > 1) {
    const last = crumbs[crumbs.length - 1];
    crumbs[crumbs.length - 1] = { label: last.label };
  } else {
    crumbs.push({ label: "Overview" });
  }

  return <Topbar crumbs={crumbs} />;
}

function labelFor(segment: string, trail: string[]): string {
  const top = trail[0];
  if (trail.length === 1) {
    switch (top) {
      case "approvals":
        return "Engage";
      case "agents":
        return "Channels";
      case "contacts":
        return "People";
      case "hire":
        return "Channel setup";
      case "spend":
        return "Spend";
      case "settings":
        return "Settings";
      case "issues":
        return "Issues";
      case "vault":
        return "Brand context";
      case "connections":
        return "Connections";
      case "org-chart":
        return "Channels";
      case "admin":
        return "Operations";
      default:
        return capitalize(top);
    }
  }
  if (trail.length === 2 && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(segment)) {
    const detailLabels: Record<string, string> = {
      approvals: "Draft review", contacts: "Contact", agents: "Channel", content: "Draft review",
    };
    if (detailLabels[top]) return detailLabels[top];
  }
  // Named page overrides take precedence over these route fallbacks.
  if (top === "admin") {
    const sub = trail[1];
    return capitalize(sub ?? "");
  }
  return segment;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

"use client";

import { AppLink as Link } from "@/components/nav/AppLink";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { ChevronRight, PanelsTopLeft } from "lucide-react";

export interface Crumb {
  label: string;
  href?: string;
}

interface TopbarProps {
  crumbs: Crumb[];
  right?: React.ReactNode;
}

export function Topbar({ crumbs, right }: TopbarProps) {
  return (
    <header className="topbar">
      <span className="topbar-workspace-icon" aria-hidden="true"><PanelsTopLeft size={18} strokeWidth={1.6} /></span>
      <nav className="crumbs" aria-label="Breadcrumb">
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <span key={`${c.label}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              {i > 0 ? <ChevronRight className="sep" size={13} aria-hidden="true" /> : null}
              {!isLast && c.href ? (
                <Link href={c.href}>{c.label}</Link>
              ) : isLast ? (
                <b aria-current="page">{c.label}</b>
              ) : (
                <span>{c.label}</span>
              )}
            </span>
          );
        })}
      </nav>
      <div className="topbar-right">
        {right}
        <ThemeToggle />

      </div>
    </header>
  );
}

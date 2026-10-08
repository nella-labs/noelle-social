import { AppLink as Link } from "@/components/nav/AppLink";

type TabId = "invitations" | "health" | "infrastructure";
const TABS: { id: TabId; label: string; path: string }[] = [
  { id: "infrastructure", label: "Infrastructure", path: "infrastructure" },
  { id: "invitations", label: "Workspace access", path: "invitations" },
  { id: "health", label: "Service health", path: "health" },
];

interface AdminTabsProps {
  active: TabId;
  orgSlug: string;
}

export async function AdminTabs({ active, orgSlug }: AdminTabsProps) {
  return (
    <div
      className="card scroll-x-phone"
      style={{
        padding: 4,
        marginBottom: 24,
        display: "flex",
        gap: 2,
      }}
    >
      {TABS.map((tab) => {
        const on = tab.id === active;
        return (
          <Link
            key={tab.id}
            href={`/app/${orgSlug}/admin/${tab.path}`}
            style={{
              flex: 1,
              height: 36,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 8,
              background: on ? "var(--paper-2)" : "transparent",
              color: on ? "var(--ink)" : "var(--ink-muted)",
              boxShadow: on ? "0 0 0 0.5px var(--rule), 0 1px 2px rgba(31,26,18,.04)" : "none",
              fontFamily: "var(--body)",
              fontSize: 13,
              fontWeight: 500,
              textDecoration: "none",
              transition: "background .15s, color .15s",
            }}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

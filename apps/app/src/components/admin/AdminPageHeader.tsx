import { PageHeader } from "@/components/nav/PageHeader";

interface AdminPageHeaderProps {
  eyebrow: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
}

/** Shared header for installation administration. */
export function AdminPageHeader({ eyebrow, title, sub, right }: AdminPageHeaderProps) {
  return <PageHeader
    eyebrow={<span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}><span className="tag">Admin</span>{eyebrow}</span>}
    title={title}
    sub={sub}
    right={right}
  />;
}

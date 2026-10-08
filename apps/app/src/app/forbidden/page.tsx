import type { Metadata } from "next";
import { ErrorScreen } from "@/components/error-screen";

export const metadata: Metadata = {
  title: "Noelle · Locked out",
};

export default function ForbiddenPage() {
  return (
    <ErrorScreen
      kind="403"
      primaryAction={{
        label: "About workspace access",
        href: "/about",
      }}
      secondaryAction={{ label: "Go to a page I can see", href: "/" }}
    />
  );
}

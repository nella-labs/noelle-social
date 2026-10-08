import { ErrorScreen } from "@/components/error-screen";

export default function NotFound() {
  return (
    <ErrorScreen
      kind="404"
      primaryAction={{ label: "Back to Noelle", href: "/" }}
      secondaryAction={{ label: "Search workspace", href: "/?search=1" }}
    />
  );
}

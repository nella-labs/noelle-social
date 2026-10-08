import { redirect } from "next/navigation";

export default async function SpendPage({ params, searchParams }: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const [{ orgSlug }, { range }] = await Promise.all([params, searchParams]);
  const query = new URLSearchParams({ tab: "spend" });
  if (range) query.set("range", range);
  redirect(`/app/${orgSlug}/connections?${query}`);
}

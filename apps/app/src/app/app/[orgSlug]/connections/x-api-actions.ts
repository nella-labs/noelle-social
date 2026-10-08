"use server";

import { revalidatePath } from "next/cache";
import { noelleFetch } from "@/lib/api";

export async function saveXApiCredsAction(
  orgSlug: string,
  creds: { consumerKey: string; consumerSecret: string; accessToken: string; accessTokenSecret: string; handle?: string },
): Promise<{ ok: true; handle: string | null }> {
  const out = await noelleFetch<{ ok: true; handle: string | null }>(`/api/x-api/creds`, {
    method: "POST",
    body: { orgSlug, ...creds },
  });
  revalidatePath(`/app/${orgSlug}/connections`);
  return out;
}

export async function disconnectXApiAction(orgSlug: string): Promise<void> {
  await noelleFetch<{ ok: true }>(`/api/x-api/creds?orgSlug=${encodeURIComponent(orgSlug)}`, { method: "DELETE" });
  revalidatePath(`/app/${orgSlug}/connections`);
}

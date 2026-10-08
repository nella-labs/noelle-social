/** Supabase's default storage key is derived from the configured auth host. Edge-safe. */
export function authSessionCookieName(url = process.env.NEXT_PUBLIC_SUPABASE_URL): string {
  try {
    const host = new URL(url ?? "").hostname.split(".")[0];
    if (host) return `sb-${host}-auth-token`;
  } catch { /* An unconfigured auth host cannot match a valid session. */ }
  return "sb-unconfigured-auth-token";
}

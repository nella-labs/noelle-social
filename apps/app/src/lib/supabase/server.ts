import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { Database } from "@/lib/db-types";

/**
 * Server-side Supabase client (RSC + Server Actions + Route Handlers).
 *
 * AUTH CLIENT — data lives in `apps/app/src/lib/db.ts`.
 *
 * Phase 4 of the Supabase → Cloud SQL migration moved every `noelle.*`
 * read/write off PostgREST and onto direct Postgres (postgres.js). This
 * client still exists because Supabase Auth (magic link, OAuth, cookie
 * refresh) is what populates the session; routes call `.auth.getUser()` /
 * `.auth.getSession()` on the result, then use the JWT's `sub` claim as
 * the trusted user id when calling the pg-backed `sql` template.
 *
 * Do NOT call `.from(...)` on this client. It's still configured with
 * `db.schema = "noelle"` for backwards compat during the cutover, but the
 * Cloud SQL data plane is the source of truth.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient<Database, "noelle">(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component — Next.js disallows mutation here.
            // Middleware handles refresh; safe to ignore.
          }
        },
      },
      db: { schema: "noelle" },
    },
  );
}

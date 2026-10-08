"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/db-types";

export function createSupabaseBrowserClient() {
  return createBrowserClient<Database, "noelle">(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { db: { schema: "noelle" } },
  );
}

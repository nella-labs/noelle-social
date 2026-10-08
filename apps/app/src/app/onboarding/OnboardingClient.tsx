"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InviteGate } from "@/components/auth/InviteGate";
import {
  autoRedeemEmailInvite,
  createOrgFromOnboarding,
  type CreateOrgResult,
} from "@/app/onboarding/actions";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Loader2 } from "lucide-react";

type Phase = "loading" | "invite" | "org-form";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const initialCreateState: CreateOrgResult = { ok: false };

export function OnboardingClient({ local }: { local: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(local ? "org-form" : "loading");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugDirty, setSlugDirty] = useState(false);
  const [createState, createAction, creating] = useActionState(
    createOrgFromOnboarding,
    initialCreateState,
  );

  // On mount: ensure session + skip onboarding if user already has an org.
  // Auth check stays on the Supabase browser client; the org_members lookup
  // is now a server action that hits Cloud SQL via postgres.js (Phase 4 of
  // the Supabase → Cloud SQL migration).
  useEffect(() => {
    if (local) return;
    let cancelled = false;
    (async () => {
      const sb = createSupabaseBrowserClient();
      const {
        data: { user },
      } = await sb.auth.getUser();
      if (!user) {
        router.replace("/");
        return;
      }
      // Edge-runtime route handler (server-action path deadlocks on Node).
      let existingSlug: string | null = null;
      try {
        const res = await fetch("/api/onboarding/first-org-slug", {
          credentials: "include",
        });
        if (res.ok) {
          const data = (await res.json()) as { slug: string | null };
          existingSlug = data.slug;
        }
      } catch {
        // Treat as "no membership" and fall through to the invite gate.
      }
      if (cancelled) return;
      if (existingSlug) {
        router.replace(`/app/${existingSlug}`);
        return;
      }
      // Email-bound invite? Auto-redeem it server-side and skip the code gate.
      try {
        const { ok } = await autoRedeemEmailInvite();
        if (cancelled) return;
        if (ok) {
          setPhase("org-form");
          return;
        }
      } catch {
        // Fall through to the manual code gate.
      }
      if (cancelled) return;
      setPhase("invite");
    })();
    return () => {
      cancelled = true;
    };
  }, [router, local]);

  const derivedSlug = useMemo(() => slugify(name), [name]);
  const effectiveSlug = slugDirty ? slug : derivedSlug;

  const fieldErrors = createState.fieldErrors;

  if (phase === "loading") {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="flex items-center gap-2 text-sm text-mist-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading…
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md flex flex-col gap-6">
        <header className="text-center flex flex-col gap-2">
          <h1 className="font-serif text-4xl text-ink-900 leading-none">
            Set up your workspace
          </h1>
          <p className="text-sm text-mist-500">
            {phase === "invite"
              ? "Enter your invitation code to continue."
              : "Name your workspace. Your X channel starts paused with sending off."}
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>
              {phase === "invite" ? "Invite required" : "Your workspace"}
            </CardTitle>
            <CardDescription>
              {phase === "invite"
                ? "Hosted access requires an invitation."
                : "You can rename it later from settings."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {phase === "invite" ? (
              <InviteGate onUnlocked={() => setPhase("org-form")} />
            ) : (
              <form action={createAction} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <label htmlFor="name" className="text-xs text-mist-500">
                    Workspace name
                  </label>
                  <Input
                    id="name"
                    name="name"
                    type="text"
                    autoComplete="organization"
                    required
                    placeholder="Acme, Inc."
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={creating}
                  />
                  {fieldErrors?.name ? (
                    <p className="text-xs text-danger-500">{fieldErrors.name}</p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-2">
                  <label htmlFor="slug" className="text-xs text-mist-500">
                    URL slug
                  </label>
                  <div className="flex items-center gap-2 max-[768px]:flex-col max-[768px]:items-stretch max-[768px]:gap-1">
                    <span className="text-xs text-mist-500 font-mono">
                      /app/
                    </span>
                    <Input
                      id="slug"
                      name="slug"
                      type="text"
                      autoComplete="off"
                      required
                      placeholder="acme"
                      value={effectiveSlug}
                      onChange={(e) => {
                        setSlugDirty(true);
                        setSlug(slugify(e.target.value));
                      }}
                      disabled={creating}
                      className="font-mono flex-1 min-w-0"
                    />
                  </div>
                  {fieldErrors?.slug ? (
                    <p className="text-xs text-danger-500">{fieldErrors.slug}</p>
                  ) : (
                    <p className="text-xs text-mist-500">
                      Lowercase, dashes, no spaces.
                    </p>
                  )}
                </div>

                <Button type="submit" variant="primary" disabled={creating}>
                  {creating ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      Creating…
                    </>
                  ) : (
                    "Create workspace"
                  )}
                </Button>

                {createState.error ? (
                  <p role="alert" className="text-xs text-danger-500">
                    {createState.error}
                  </p>
                ) : null}
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

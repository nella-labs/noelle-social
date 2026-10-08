"use client";

import { useActionState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import {
  redeemInviteCode,
  type RedeemInviteResult,
} from "@/app/onboarding/actions";

interface InviteGateProps {
  onUnlocked: () => void;
}

const initialState: RedeemInviteResult = { ok: false };

export function InviteGate({ onUnlocked }: InviteGateProps) {
  const [state, formAction, pending] = useActionState(
    redeemInviteCode,
    initialState,
  );

  useEffect(() => {
    if (state.ok) onUnlocked();
  }, [state.ok, onUnlocked]);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label htmlFor="code" className="text-xs text-mist-500">
        Alpha invite code
      </label>
      <Input
        id="code"
        name="code"
        type="text"
        autoComplete="off"
        autoFocus
        required
        placeholder="e.g. constellation-0001"
        disabled={pending}
      />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Checking…
          </>
        ) : (
          "Unlock onboarding"
        )}
      </Button>
      {state.error ? (
        <p role="alert" className="text-xs text-danger-500">
          {state.error}
        </p>
      ) : null}
      <p className="text-xs text-mist-500">
        Noelle is in private alpha. If you don't have a code, join the waitlist
        at{" "}
        <a
          href="https://trynoelle.com"
          className="text-ink-900 underline-offset-2 hover:underline"
        >
          trynoelle.com
        </a>
        .
      </p>
    </form>
  );
}

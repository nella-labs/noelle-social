/**
 * Single source of truth for the noelle_invite_redeemed cookie HMAC secret.
 * NEVER falls back to NEXT_PUBLIC_SUPABASE_ANON_KEY (that value ships to every
 * browser — signing the invite-redeemed cookie with it lets anyone forge past
 * the alpha invite gate). Fails CLOSED: in production a missing secret throws
 * (callers treat that as deny), rather than trusting a weak public key.
 *
 * Mirrors resolveGateSecret. Node-only is fine here (this backs the server-only
 * /onboarding actions), but the resolver stays pure — env passed as an arg, no
 * process.env / Date.now inside — so it is unit-testable.
 */
export function resolveInviteSecret(env: {
  NOELLE_INVITE_COOKIE_SECRET?: string;
  NODE_ENV?: string;
}): string {
  const secret = env.NOELLE_INVITE_COOKIE_SECRET;
  if (secret && secret.length > 0) return secret;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "NOELLE_INVITE_COOKIE_SECRET is required in production (refusing to sign the invite-redeemed cookie with a weak/public key)",
    );
  }
  return "noelle-dev-invite-secret";
}

export function getInviteSecret(): string {
  return resolveInviteSecret({
    NOELLE_INVITE_COOKIE_SECRET: process.env.NOELLE_INVITE_COOKIE_SECRET,
    NODE_ENV: process.env.NODE_ENV,
  });
}

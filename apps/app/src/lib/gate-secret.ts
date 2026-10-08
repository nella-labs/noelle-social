/**
 * Single source of truth for the noelle_email_verified gate-cookie HMAC secret.
 * NEVER falls back to NEXT_PUBLIC_SUPABASE_ANON_KEY (that value ships to every
 * browser — signing the invite-gate cookie with it lets anyone forge past the
 * noelle.invited_emails allowlist). Fails CLOSED: in production a missing
 * secret throws (callers treat that as deny), rather than trusting a weak key.
 * Edge-safe: only reads process.env.
 */
export function resolveGateSecret(env: {
  NOELLE_GATE_COOKIE_SECRET?: string;
  NODE_ENV?: string;
}): string {
  const secret = env.NOELLE_GATE_COOKIE_SECRET;
  if (secret && secret.length > 0) return secret;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "NOELLE_GATE_COOKIE_SECRET is required in production (refusing to sign the invite-gate cookie with a weak/public key)",
    );
  }
  return "noelle-dev-gate-secret";
}

export function getGateSecret(): string {
  return resolveGateSecret({
    NOELLE_GATE_COOKIE_SECRET: process.env.NOELLE_GATE_COOKIE_SECRET,
    NODE_ENV: process.env.NODE_ENV,
  });
}

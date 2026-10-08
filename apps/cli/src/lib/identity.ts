import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

/**
 * Operator identity + secret generation for the single-user local-auth shim.
 *
 * The CLI mints a long-lived HS256 JWT signed with the local
 * NOELLE_SUPABASE_JWT_SECRET. The dashboard forwards it to api-vm, which
 * verifies it with the same secret via its existing JWT path — so the trust
 * boundary (assertOrgMember on the seeded org) is unchanged.
 */

/** A URL-safe random secret (default 48 bytes → 64 base64url chars). */
export function generateSecret(bytes = 48): string {
  return randomBytes(bytes).toString("base64url");
}

export interface MintArgs {
  secret: string;
  sub: string;
  email: string;
  /** Token lifetime; default 30 days. */
  expiresIn?: string;
}

/** Mint the operator JWT the dashboard sends to api-vm as a Bearer token. */
export async function mintOperatorJwt(args: MintArgs): Promise<string> {
  const key = new TextEncoder().encode(args.secret);
  return new SignJWT({ email: args.email, role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(args.sub)
    .setIssuedAt()
    .setExpirationTime(args.expiresIn ?? "30d")
    .sign(key);
}

/** Decoded `exp` claim (unix seconds) of a JWT, or null when unreadable. */
export function jwtExp(jwt: string): number | null {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" && Number.isSafeInteger(payload.exp) && payload.exp > 0 ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * True when the token is missing, unreadable, already expired, or expires
 * within `withinSeconds`. Pure decode — no signature check; the caller holds
 * the signing secret anyway, it only needs to know WHEN to re-mint. The token
 * is minted once at `noelle init` with a 30d lifetime, so without re-minting
 * every self-host dashboard loses its api-vm actions (401s) a month in.
 */
export function jwtNeedsRemint(
  jwt: string | undefined,
  withinSeconds: number,
  nowMs: number = Date.now(),
): boolean {
  if (!jwt) return true;
  const exp = jwtExp(jwt);
  if (exp === null) return true;
  return exp * 1000 - nowMs < withinSeconds * 1000;
}

/** Check the local signing secret and operator identity as well as token age. */
export async function operatorJwtNeedsRemint(args: MintArgs & { jwt?: string; withinSeconds: number }): Promise<boolean> {
  if (jwtNeedsRemint(args.jwt, args.withinSeconds)) return true;
  try {
    const { payload } = await jwtVerify(args.jwt!, new TextEncoder().encode(args.secret), {
      algorithms: ["HS256"], subject: args.sub,
    });
    return payload.email !== args.email || payload.role !== "authenticated";
  } catch {
    return true;
  }
}

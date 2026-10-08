"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OrgMembershipError } from "@noelle/runtime";
import {
  getCurrentUser,
  getOrgBySlug,
  addApifyConnection,
  addApifyConnectionsBulk,
  parseApifyTokens,
  setApifyConnectionInUse,
  removeApifyConnection,
  listApifyConnectionSecrets,
  clearApifyConnectionInvalid,
} from "@/lib/queries";
import { checkApifyAccountUsage } from "@noelle/runtime/apify-usage";
import { saveApifyUsage } from "@noelle/runtime/apify-usage-db";
import { sql } from "@/lib/db";
import {
  CONNECTIONS,
  type ConnectionKindId,
} from "@/lib/connections-registry";
import {
  setConnectionValue,
  disableConnection,
} from "@/lib/connections";

const ALL_KIND_IDS = CONNECTIONS.map((c) => c.id) as [ConnectionKindId, ...ConnectionKindId[]];

const SetInput = z.object({
  orgSlug: z.string().min(1),
  kind: z.enum(ALL_KIND_IDS),
  value: z.string().min(1).max(20_000),
});

const KindOnlyInput = z.object({
  orgSlug: z.string().min(1),
  kind: z.enum(ALL_KIND_IDS),
});

export type ActionResult =
  | { ok: true; preview?: string }
  | { ok: false; error: { code: string; message: string } };

async function authorize(orgSlug: string) {
  const user = await getCurrentUser();
  if (!user) return { kind: "unauthenticated" as const };
  try {
    const org = await getOrgBySlug(orgSlug);
    if (!org) return { kind: "not_found" as const };
    return { kind: "ok" as const, org, user };
  } catch (err) {
    if (err instanceof OrgMembershipError) return { kind: "forbidden" as const };
    throw err;
  }
}

/**
 * Validate + write to Secret Manager. Returns a masked preview on success.
 */
export async function setConnection(input: z.infer<typeof SetInput>): Promise<ActionResult> {
  const parsed = SetInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const auth = await authorize(parsed.data.orgSlug);
  if (auth.kind === "unauthenticated") return { ok: false, error: { code: auth.kind, message: "Sign in first." } };
  if (auth.kind === "forbidden") return { ok: false, error: { code: auth.kind, message: "Not a member of this org." } };
  if (auth.kind === "not_found") return { ok: false, error: { code: auth.kind, message: "Org not found." } };

  const spec = CONNECTIONS.find((c) => c.id === parsed.data.kind);
  if (!spec) return { ok: false, error: { code: "unknown_kind", message: parsed.data.kind } };

  // Always trim — pastes commonly carry trailing newlines.
  const value = parsed.data.value.trim();

  // Validate locally before hitting Secret Manager (cheap path).
  const validationError = await spec.validate(value);
  if (validationError) {
    return { ok: false, error: { code: "invalid_value", message: validationError } };
  }

  try {
    await setConnectionValue(auth.org.id, parsed.data.kind, value);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "store_failed",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  revalidatePath(`/app/${parsed.data.orgSlug}/connections`);
  // Don't return the raw value; return a tiny mask the UI can show optimistically
  // before the next status fetch.
  const preview = value.length >= 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : "***";
  return { ok: true, preview };
}

/**
 * Disable all enabled versions of the secret (audit-friendly: we don't delete).
 */
export async function disconnectConnection(input: z.infer<typeof KindOnlyInput>): Promise<ActionResult> {
  const parsed = KindOnlyInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const auth = await authorize(parsed.data.orgSlug);
  if (auth.kind === "unauthenticated") return { ok: false, error: { code: auth.kind, message: "Sign in first." } };
  if (auth.kind === "forbidden") return { ok: false, error: { code: auth.kind, message: "Not a member of this org." } };
  if (auth.kind === "not_found") return { ok: false, error: { code: auth.kind, message: "Org not found." } };

  try {
    await disableConnection(auth.org.id, parsed.data.kind);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "disable_failed",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
  revalidatePath(`/app/${parsed.data.orgSlug}/connections`);
  return { ok: true };
}

const ApifyInput = z.object({
  orgSlug: z.string().min(1),
  value: z.string().min(1).max(20_000),
});

const RemoveApifyInput = z.object({
  orgSlug: z.string().min(1),
  credentialId: z.string().uuid(),
});

const BulkApifyInput = z.object({
  orgSlug: z.string().min(1),
  // Free-form paste: one-per-line / comma / space separated. Bounded so a runaway
  // paste can't blow the action body.
  value: z.string().min(1).max(200_000),
});

const SetApifyInUseInput = z.object({
  orgSlug: z.string().min(1),
  credentialId: z.string().uuid(),
  inUse: z.boolean(),
});

export type BulkApifyResult =
  | { ok: true; added: number; alreadyPresent: number; skipped: number }
  | { ok: false; error: { code: string; message: string } };

/**
 * Add an Apify token to the org's fallback pool. DB-backed (noelle.connections) —
 * unlike the SM-backed connections above — so the VM workers read it live
 * (hot-swap) and rotate to it when an earlier token hits its monthly cap. Does
 * NOT replace the existing tokens (stack as many as you like). Masked preview.
 */
export async function addApifyToken(input: z.infer<typeof ApifyInput>): Promise<ActionResult> {
  const parsed = ApifyInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const auth = await authorize(parsed.data.orgSlug);
  if (auth.kind === "unauthenticated") return { ok: false, error: { code: auth.kind, message: "Sign in first." } };
  if (auth.kind === "forbidden") return { ok: false, error: { code: auth.kind, message: "Not a member of this org." } };
  if (auth.kind === "not_found") return { ok: false, error: { code: auth.kind, message: "Org not found." } };

  const value = parsed.data.value.trim();
  if (value.length < 12) {
    return { ok: false, error: { code: "invalid_value", message: "That doesn't look like an Apify token." } };
  }
  try {
    await addApifyConnection(auth.org.id, value);
  } catch (err) {
    return { ok: false, error: { code: "store_failed", message: err instanceof Error ? err.message : String(err) } };
  }
  revalidatePath(`/app/${parsed.data.orgSlug}/connections`);
  return { ok: true, preview: `${value.slice(0, 4)}…${value.slice(-4)}` };
}

/**
 * Bulk-add Apify tokens from a free-form paste (one-per-line / comma / space). Each
 * lands as SPARE (parked) — the operator promotes the ones to use with setApifyTokenInUse.
 * Returns a count summary: added (new rows), alreadyPresent (re-armed dupes), skipped
 * (fragments too short to be a token).
 */
export async function addApifyTokensBulk(input: z.infer<typeof BulkApifyInput>): Promise<BulkApifyResult> {
  const parsed = BulkApifyInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const auth = await authorize(parsed.data.orgSlug);
  if (auth.kind === "unauthenticated") return { ok: false, error: { code: auth.kind, message: "Sign in first." } };
  if (auth.kind === "forbidden") return { ok: false, error: { code: auth.kind, message: "Not a member of this org." } };
  if (auth.kind === "not_found") return { ok: false, error: { code: auth.kind, message: "Org not found." } };

  const { tokens, rejected } = parseApifyTokens(parsed.data.value);
  if (tokens.length === 0) {
    return { ok: false, error: { code: "no_tokens", message: "No valid Apify tokens found in that paste." } };
  }
  try {
    const { added, alreadyPresent } = await addApifyConnectionsBulk(auth.org.id, tokens);
    revalidatePath(`/app/${parsed.data.orgSlug}/connections`);
    return { ok: true, added, alreadyPresent, skipped: rejected };
  } catch (err) {
    return { ok: false, error: { code: "store_failed", message: err instanceof Error ? err.message : String(err) } };
  }
}

/** Promote (inUse=true) or demote (inUse=false) an Apify token between the two buckets. */
export async function setApifyTokenInUse(input: z.infer<typeof SetApifyInUseInput>): Promise<ActionResult> {
  const parsed = SetApifyInUseInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const auth = await authorize(parsed.data.orgSlug);
  if (auth.kind === "unauthenticated") return { ok: false, error: { code: auth.kind, message: "Sign in first." } };
  if (auth.kind === "forbidden") return { ok: false, error: { code: auth.kind, message: "Not a member of this org." } };
  if (auth.kind === "not_found") return { ok: false, error: { code: auth.kind, message: "Org not found." } };

  try {
    await setApifyConnectionInUse(auth.org.id, parsed.data.credentialId, parsed.data.inUse);
  } catch (err) {
    return { ok: false, error: { code: "store_failed", message: err instanceof Error ? err.message : String(err) } };
  }
  revalidatePath(`/app/${parsed.data.orgSlug}/connections`);
  return { ok: true };
}

/** Remove a token from the org's Apify pool (soft — keeps its spend history). */
export async function removeApifyToken(input: z.infer<typeof RemoveApifyInput>): Promise<ActionResult> {
  const parsed = RemoveApifyInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const auth = await authorize(parsed.data.orgSlug);
  if (auth.kind === "unauthenticated") return { ok: false, error: { code: auth.kind, message: "Sign in first." } };
  if (auth.kind === "forbidden") return { ok: false, error: { code: auth.kind, message: "Not a member of this org." } };
  if (auth.kind === "not_found") return { ok: false, error: { code: auth.kind, message: "Org not found." } };

  try {
    await removeApifyConnection(auth.org.id, parsed.data.credentialId);
  } catch (err) {
    return { ok: false, error: { code: "store_failed", message: err instanceof Error ? err.message : String(err) } };
  }
  revalidatePath(`/app/${parsed.data.orgSlug}/connections`);
  return { ok: true };
}

/**
 * Validate a pasted value WITHOUT storing it. Lets the UI show a green check
 * before the user clicks Save, when they want.
 */
export async function testConnectionValue(input: z.infer<typeof SetInput>): Promise<ActionResult> {
  const parsed = SetInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const auth = await authorize(parsed.data.orgSlug);
  if (auth.kind === "unauthenticated") return { ok: false, error: { code: auth.kind, message: "Sign in first." } };
  if (auth.kind === "forbidden") return { ok: false, error: { code: auth.kind, message: "Not a member of this org." } };
  if (auth.kind === "not_found") return { ok: false, error: { code: auth.kind, message: "Org not found." } };

  const spec = CONNECTIONS.find((c) => c.id === parsed.data.kind);
  if (!spec) return { ok: false, error: { code: "unknown_kind", message: parsed.data.kind } };

  const value = parsed.data.value.trim();
  const validationError = await spec.validate(value);
  if (validationError) {
    return { ok: false, error: { code: "invalid_value", message: validationError } };
  }
  return { ok: true };
}


const TestApifyInput = z.object({
  orgSlug: z.string().min(1),
  credentialId: z.string().uuid(),
});

const TestAllApifyInput = z.object({
  orgSlug: z.string().min(1),
});

/**
 * Per-token health-check result. NEVER carries the secret — only the masked
 * label + the alive/budget signals from checkApifyToken, plus `revalidated` when
 * an invalid-marked token tested alive and we cleared its flag.
 */
export interface ApifyTokenTestResult {
  credentialId: string;
  label: string;
  alive: boolean;
  httpStatus: number;
  monthlyUsageUsd?: number;
  maxMonthlyUsageUsd?: number;
  remainingUsd?: number;
  plan?: string;
  /** True when this token was marked invalid but tested alive and got resurrected. */
  revalidated?: boolean;
  /** Health-check error string (network/transport or a non-200 body), when any. */
  error?: string;
}

export type TestApifyResult =
  | { ok: true; result: ApifyTokenTestResult }
  | { ok: false; error: { code: string; message: string } };

export type TestAllApifyResult =
  | { ok: true; results: ApifyTokenTestResult[] }
  | { ok: false; error: { code: string; message: string } };

/**
 * Read and save Apify account/cycle usage (management API requests only).
 * The secret is loaded + used server-side only and never returned. If the token
 * tests ALIVE but is currently marked invalid (a wrongful single-401 retirement),
 * its invalid flag is cleared so it re-enters the worker rotation (revalidated).
 */
async function testOneApify(
  orgId: string,
  conn: { id: string; label: string; secret: string; invalid: boolean },
): Promise<ApifyTokenTestResult> {
  const health = await checkApifyAccountUsage(conn.secret);
  if (health.alive) {
    const saved = await saveApifyUsage(sql, orgId, conn.id, health);
    if (!saved.saved) throw new Error(`Apify usage was not saved: ${saved.reason}. Try again.`);
  }
  let revalidated = false;
  if (health.alive && conn.invalid) {
    // It was retired (likely on a transient 401) but is actually fine — resurrect.
    await clearApifyConnectionInvalid(orgId, conn.id);
    revalidated = true;
  }
  return {
    credentialId: conn.id,
    label: conn.label,
    alive: health.alive,
    httpStatus: health.httpStatus,
    ...(health.monthlyUsageUsd !== undefined ? { monthlyUsageUsd: health.monthlyUsageUsd } : {}),
    ...(health.maxMonthlyUsageUsd !== undefined ? { maxMonthlyUsageUsd: health.maxMonthlyUsageUsd } : {}),
    ...(health.remainingUsd !== undefined ? { remainingUsd: health.remainingUsd } : {}),
    ...(revalidated ? { revalidated } : {}),
    ...(health.error ? { error: health.error } : {}),
  };
}

/** Health-check ONE of the org's Apify tokens (by credentialId). */
export async function testApifyToken(input: z.infer<typeof TestApifyInput>): Promise<TestApifyResult> {
  const parsed = TestApifyInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const auth = await authorize(parsed.data.orgSlug);
  if (auth.kind === "unauthenticated") return { ok: false, error: { code: auth.kind, message: "Sign in first." } };
  if (auth.kind === "forbidden") return { ok: false, error: { code: auth.kind, message: "Not a member of this org." } };
  if (auth.kind === "not_found") return { ok: false, error: { code: auth.kind, message: "Org not found." } };

  const conns = await listApifyConnectionSecrets(auth.org.id);
  const conn = conns.find((c) => c.id === parsed.data.credentialId);
  if (!conn) return { ok: false, error: { code: "not_found", message: "Token not in this org's pool." } };

  try {
    const result = await testOneApify(auth.org.id, conn);
    revalidatePath(`/app/${parsed.data.orgSlug}/connections`);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: { code: "check_failed", message: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * Health-check ALL of the org's Apify tokens (bounded concurrency), resurrecting
 * any that were marked invalid but test alive. Returns one result per token.
 */
export async function testAllApifyTokens(input: z.infer<typeof TestAllApifyInput>): Promise<TestAllApifyResult> {
  const parsed = TestAllApifyInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "bad_input", message: parsed.error.message } };
  }
  const auth = await authorize(parsed.data.orgSlug);
  if (auth.kind === "unauthenticated") return { ok: false, error: { code: auth.kind, message: "Sign in first." } };
  if (auth.kind === "forbidden") return { ok: false, error: { code: auth.kind, message: "Not a member of this org." } };
  if (auth.kind === "not_found") return { ok: false, error: { code: auth.kind, message: "Org not found." } };

  const orgId = auth.org.id;
  const conns = await listApifyConnectionSecrets(orgId);
  try {
    // Bounded concurrency: 4 in flight so a big pool doesn't fan out unbounded.
    const CONCURRENCY = 4;
    const results: ApifyTokenTestResult[] = new Array(conns.length);
    let next = 0;
    async function worker() {
      while (true) {
        const i = next++;
        if (i >= conns.length) return;
        results[i] = await testOneApify(orgId, conns[i]!);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, conns.length) }, worker));
    revalidatePath(`/app/${parsed.data.orgSlug}/connections`);
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: { code: "check_failed", message: err instanceof Error ? err.message : String(err) } };
  }
}

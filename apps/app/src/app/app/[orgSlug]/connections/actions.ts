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

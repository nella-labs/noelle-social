/**
 * High-level Secret Manager operations for the connections UI.
 *
 * Each org's secrets live at:
 *   projects/noelle-agents/secrets/noelle--org--<orgId>--<secretFragment>
 *
 * GCP secret names only allow [-A-Za-z0-9_], so "/" is represented as "--".
 *
 * Legacy global fallback (seeded during bring-up so workers always had
 * something to read):
 *   projects/noelle-agents/secrets/noelle-worker-<secretFragment>
 *
 * The worker's SecretsClient.getForOrg() resolves per-org first, then global;
 * this module mirrors that order so the UI's "connected" badge tracks what
 * the worker actually sees.
 *
 * Tenancy is enforced by the callers — every route that reaches this module
 * must have already called `assertOrgMember` from `@noelle/runtime/tenancy`
 * before passing in an orgId. This module does no auth checks of its own.
 *
 * IMPORTANT: `peekConnectionValue` returns the raw secret payload. It must
 * NEVER be forwarded to the client — only used server-side (e.g., for
 * worker injection or re-validation).
 */

import { getSecretManagerClient, SM_PROJECT } from "./sm";
import { disableAllSecretVersions, disableOlderSecretVersions } from "./secret-versions";
import {
  CONNECTIONS,
  type ConnectionKindId,
  type ConnectionKindSpec,
} from "./connections-registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectionStatus {
  kind: ConnectionKindId;
  status: "not_set" | "connected" | "error";
  /** First 4 + last 4 chars of the stored value, separated by ellipsis. Null when not_set. */
  preview: string | null;
  /** ISO timestamp from the latest enabled version's createTime, or null when not_set. */
  lastUpdatedAt: string | null;
  /** Error message when status is "error" (e.g. validation failed at fetch time). */
  errorMessage: string | null;
  /**
   * Where the connected value lives in Secret Manager:
   * - "org"    → per-workspace secret `noelle--org--<orgId>--<fragment>` (canonical path,
   *              the one set by this UI; takes precedence over a global default).
   * - "global" → legacy flat secret `noelle-worker-<fragment>` (alpha default seeded
   *              during bring-up; what the worker SecretsClient falls back to).
   * - null     → no value set anywhere (status is "not_set" or "error").
   *
   * The worker resolves these in the same order: per-org first, then global fallback.
   */
  source: "org" | "global" | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function specFor(kind: ConnectionKindId): ConnectionKindSpec {
  const spec = CONNECTIONS.find((c) => c.id === kind);
  if (!spec) throw new Error(`Unknown connection kind: ${kind}`);
  return spec;
}

/**
 * Compose the per-org secret resource name from a kind.
 *
 * Example:
 *   orgId = "org-abc123", kind = "gemini"
 *   → "projects/noelle-agents/secrets/noelle--org--org-abc123--gemini-api-key"
 */
export function secretResourceName(orgId: string, kind: ConnectionKindId): string {
  const spec = specFor(kind);
  return `projects/${SM_PROJECT}/secrets/noelle--org--${orgId}--${spec.secretFragment}`;
}

/**
 * Compose the legacy global (flat) secret resource name for a kind.
 *
 * These were seeded during bring-up so workers had something to read from
 * before the per-org UI existed. The x-intern SecretsClient.getForOrg
 * falls back to this exact name when the per-org secret is NOT_FOUND.
 *
 * Example:
 *   kind = "gemini" → "projects/noelle-agents/secrets/noelle-worker-gemini-api-key"
 */
export function globalSecretResourceName(kind: ConnectionKindId): string {
  const spec = specFor(kind);
  return `projects/${SM_PROJECT}/secrets/noelle-worker-${spec.secretFragment}`;
}

/** Mask a secret value for display: first4…last4, or *** if shorter than 12 chars. */
function maskValue(value: string): string {
  if (value.length < 12) return "***";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type SmClient = Awaited<ReturnType<typeof getSecretManagerClient>>;

/**
 * Inspect a single Secret Manager resource. Returns the latest enabled
 * version's masked preview + ISO createTime, or null if the secret is
 * NOT_FOUND or has no enabled versions. Throws on any other error.
 */
async function probeSecret(
  sm: SmClient,
  name: string,
): Promise<{ preview: string | null; lastUpdatedAt: string | null } | null> {
  try {
    await sm.getSecret({ name });
  } catch (err: unknown) {
    const code = (err as { code?: number | string }).code;
    if (code === 5 || code === "NOT_FOUND") return null;
    throw err;
  }

  const [versions] = await sm.listSecretVersions({
    parent: name,
    filter: "state:ENABLED",
    pageSize: 1,
  });

  if (!versions || versions.length === 0) return null;

  const latest = versions[0];
  const latestName = latest.name ?? "";

  const [accessed] = await sm.accessSecretVersion({ name: latestName });
  const raw = accessed.payload?.data;
  const valueStr =
    raw instanceof Uint8Array
      ? Buffer.from(raw).toString("utf-8")
      : typeof raw === "string"
        ? raw
        : null;

  const preview = valueStr ? maskValue(valueStr) : null;

  const ct = latest.createTime as
    | { seconds?: string | number | bigint; nanos?: number }
    | null
    | undefined;
  let lastUpdatedAt: string | null = null;
  if (ct?.seconds != null) {
    const ms = Number(ct.seconds) * 1000;
    lastUpdatedAt = new Date(ms).toISOString();
  }

  return { preview, lastUpdatedAt };
}

/**
 * Probe whether a connection's secret exists and has at least one enabled version.
 *
 * Resolution order mirrors the worker (`apps/x-intern/src/lib/secrets.ts`):
 *   1. Per-org secret `noelle--org--<orgId>--<fragment>` → source: "org"
 *   2. Legacy global secret `noelle-worker-<fragment>`   → source: "global"
 *   3. Neither exists                                     → not_set
 *
 * Without step 2 the UI would show "not connected" while the worker is
 * happily reading from the global fallback — and a user who pastes a
 * per-org value won't realise they're overriding an alpha default.
 *
 * Errors checking the per-org secret are returned as status "error". Errors
 * checking the global fallback are swallowed (best-effort): a broken
 * global probe must not poison the per-org status.
 */
export async function getConnectionStatus(
  orgId: string,
  kind: ConnectionKindId,
): Promise<ConnectionStatus> {
  const sm = await getSecretManagerClient();
  const orgName = secretResourceName(orgId, kind);
  const globalName = globalSecretResourceName(kind);

  // 1. Per-org first — this is the canonical path written by setConnectionValue.
  let orgProbe: { preview: string | null; lastUpdatedAt: string | null } | null;
  try {
    orgProbe = await probeSecret(sm, orgName);
  } catch (err: unknown) {
    return {
      kind,
      status: "error",
      preview: null,
      lastUpdatedAt: null,
      errorMessage: (err as Error).message ?? "Unknown error reading per-org secret.",
      source: null,
    };
  }

  if (orgProbe) {
    return {
      kind,
      status: "connected",
      preview: orgProbe.preview,
      lastUpdatedAt: orgProbe.lastUpdatedAt,
      errorMessage: null,
      source: "org",
    };
  }

  // 2. No per-org value — check the legacy global secret the worker falls back to.
  //    Best-effort: never surface global-probe errors to the user. If the
  //    global path is broken we just report "not_set", same as before.
  try {
    const globalProbe = await probeSecret(sm, globalName);
    if (globalProbe) {
      return {
        kind,
        status: "connected",
        preview: globalProbe.preview,
        lastUpdatedAt: globalProbe.lastUpdatedAt,
        errorMessage: null,
        source: "global",
      };
    }
  } catch {
    // swallow — fall through to not_set
  }

  return {
    kind,
    status: "not_set",
    preview: null,
    lastUpdatedAt: null,
    errorMessage: null,
    source: null,
  };
}

/**
 * List status for every kind in the registry.
 * Used by the connections page render.
 */
export async function listConnectionStatuses(orgId: string): Promise<ConnectionStatus[]> {
  return Promise.all(CONNECTIONS.map((spec) => getConnectionStatus(orgId, spec.id)));
}

/**
 * Mode-agnostic Pushover connectivity check for the Alerts UI.
 *
 * Self-host (NOELLE_SECRETS_SOURCE=env, e.g. the Lima VM) puts the keys
 * straight in the process env, so check that first — getConnectionStatus only
 * knows about GCP Secret Manager and would falsely report "not connected" on a
 * VM that's actually wired. Hosted falls back to the per-org / global Secret
 * Manager probe.
 */
export async function getPushoverConnection(
  orgId: string,
): Promise<{ connected: boolean; source: "env" | "org" | "global" | null }> {
  if (process.env.PUSHOVER_USER_KEY && process.env.PUSHOVER_APP_TOKEN) {
    return { connected: true, source: "env" };
  }
  // env-sourced deployment with the keys missing → nothing in Secret Manager
  // to probe, so don't pay the round-trip; report not connected.
  if (process.env.NOELLE_SECRETS_SOURCE === "env") {
    return { connected: false, source: null };
  }
  try {
    const [user, token] = await Promise.all([
      getConnectionStatus(orgId, "pushover_user"),
      getConnectionStatus(orgId, "pushover_token"),
    ]);
    const connected = user.status === "connected" && token.status === "connected";
    return { connected, source: connected ? (user.source ?? token.source) : null };
  } catch {
    return { connected: false, source: null };
  }
}

/**
 * Create the secret if it doesn't already exist, then add a new version with
 * the pasted value. Validates the value before writing.
 *
 * Older enabled versions are disabled after the new version is added to keep
 * storage tidy (the version history remains in the audit log).
 *
 * Throws on validation failure or IAM/API error.
 */
export async function setConnectionValue(
  orgId: string,
  kind: ConnectionKindId,
  value: string,
): Promise<void> {
  const spec = specFor(kind);

  // Validate before touching Secret Manager.
  const validationError = await spec.validate(value);
  if (validationError) {
    throw new Error(`Validation failed: ${validationError}`);
  }

  const sm = await getSecretManagerClient();
  const name = secretResourceName(orgId, kind);
  const parent = `projects/${SM_PROJECT}`;
  const secretId = name.replace(`${parent}/secrets/`, "");

  // Create the secret if it doesn't exist yet (ignore ALREADY_EXISTS / code 6).
  try {
    await sm.createSecret({
      parent,
      secretId,
      secret: {
        name,
        replication: { automatic: {} },
        labels: { "noelle-org": orgId.toLowerCase().replace(/[^a-z0-9-_]/g, "-") },
      },
    });
  } catch (err: unknown) {
    if (
      (err as { code?: number | string }).code !== 6 &&
      (err as { code?: string }).code !== "ALREADY_EXISTS"
    ) {
      // 6 = ALREADY_EXISTS — anything else is a real error
      throw err;
    }
  }

  // Add the new version.
  const [added] = await sm.addSecretVersion({
    parent: name,
    payload: { data: Buffer.from(value) },
  });

  // Keep the acknowledged version and any concurrent newer write enabled.
  try {
    await disableOlderSecretVersions(sm, name, added.name);
  } catch {
    // Cleanup failure is non-fatal.
  }
}

/**
 * Disable all enabled versions of the secret.
 * We never delete — the version history remains in the audit log.
 *
 * Safe to call on a non-existent secret (no-op).
 */
export async function disableConnection(orgId: string, kind: ConnectionKindId): Promise<void> {
  const sm = await getSecretManagerClient();
  const name = secretResourceName(orgId, kind);

  try {
    await disableAllSecretVersions(sm, name);
  } catch (err: unknown) {
    if (
      (err as { code?: number | string }).code === 5 ||
      (err as { code?: string }).code === "NOT_FOUND"
    )
      return;
    throw err;
  }
}

/**
 * Fetch the raw plaintext value of the latest enabled version.
 *
 * Returns null when the secret doesn't exist or has no enabled versions.
 *
 * SECURITY: This returns the raw secret value. Callers MUST NOT forward this
 * to the client. Only used server-side (worker injection, re-validation).
 */
export async function peekConnectionValue(
  orgId: string,
  kind: ConnectionKindId,
): Promise<string | null> {
  const sm = await getSecretManagerClient();
  const name = secretResourceName(orgId, kind);

  try {
    const [versions] = await sm.listSecretVersions({
      parent: name,
      filter: "state:ENABLED",
      pageSize: 1,
    });

    if (!versions || versions.length === 0) return null;

    const [accessed] = await sm.accessSecretVersion({ name: versions[0].name! });
    const raw = accessed.payload?.data;

    if (raw instanceof Uint8Array) return Buffer.from(raw).toString("utf-8");
    if (typeof raw === "string") return raw;
    return null;
  } catch (err: unknown) {
    if (
      (err as { code?: number | string }).code === 5 ||
      (err as { code?: string }).code === "NOT_FOUND"
    )
      return null;
    throw err;

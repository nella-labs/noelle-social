export { createSecretManagerClient } from "./secretManager.js";
export { SecretManagerProcess } from "./secretProcess.js";
export type { SecretWifAuth, SecretProcessConfig, SecretVersion } from "./secretProtocol.js";
import {
  createSecretAccessor,
  SecretAccessError,
  secretTimeoutMs,
  type AccessFn,
  type SecretSdkOptions,
} from "./secretAccess.js";
import type { GoogleAuthOptions } from "google-auth-library";
export { SecretAccessError } from "./secretAccess.js";

export interface SecretsClient {
  get(name: string): Promise<string>;
  getForOrg(orgId: string, fragment: string): Promise<string>;
  // Best-effort prefetch; missing/denied secrets still throw at get() call.
  warm(names: string[]): Promise<void>;
  /**
   * Evict a single secret id from the in-memory cache so the next read
   * re-fetches from Secret Manager. Use after a known rotation when you can't
   * afford to wait for the TTL. Safe to call with an id that isn't cached.
   */
  bust(secretId: string): void;
}

/**
 * Map a secret id to the env-var name the env-backed source reads. Exported so
 * the self-host CLI's env writer emits exactly the names this client expects —
 * one mapping, no drift. e.g. `noelle-postgres-app-password` →
 * `NOELLE_SECRET_NOELLE_POSTGRES_APP_PASSWORD`.
 */
export function secretIdToEnvKey(secretId: string): string {
  return "NOELLE_SECRET_" + secretId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * An `accessSecretVersion` implementation that resolves secrets from
 * `process.env` instead of GCP Secret Manager. Used by self-host deployments
 * (`NOELLE_SECRETS_SOURCE=env`). It satisfies the same seam as the GCP client,
 * so the cache / TTL / getForOrg-fallback / bust logic stays identical. A
 * missing env var throws `{ code: 5 }` so it maps to the existing NOT_FOUND
 * path (preserving getForOrg's legacy fallback).
 */
function makeEnvAccessClient(): { accessSecretVersion: AccessFn } {
  return {
    async accessSecretVersion({ name }) {
      // name = projects/<project>/secrets/<id>/versions/latest
      const match = name.match(/\/secrets\/([^/]+)\//);
      const secretId = match?.[1] ?? name;
      const value = process.env[secretIdToEnvKey(secretId)];
      if (value == null || value === "") {
        throw { code: 5, message: `env ${secretIdToEnvKey(secretId)} not set` };
      }
      return [{ payload: { data: value } }];
    },
  };
}

/**
 * Resolve which secret source to use. An explicit `opts.source` wins; otherwise
 * `NOELLE_SECRETS_SOURCE=env` selects the env-backed client. Defaults to GCP so
 * the managed deployment is unchanged when the var is unset.
 */
function resolveSource(explicit?: "gcp" | "env"): "gcp" | "env" {
  if (explicit) return explicit;
  return process.env.NOELLE_SECRETS_SOURCE === "env" ? "env" : "gcp";
}

/** Normalise a legacy name: replace `/` → `-` to form a valid GCP secret ID. */
function normaliseName(name: string): string {
  if (name.includes("/")) {
    if (process.env.NODE_ENV !== "production") {
      process.stderr.write(
        `[secrets] WARNING: secret name "${name}" contains "/", normalising to dashes.\n`,
      );
    }
    return name.replace(/\//g, "-");
  }
  return name;
}

export function createSecretsClient(opts: {
  project: string;
  ttlMs?: number;
  now?: () => number;
  /**
   * Where secrets come from. "gcp" (default) reads GCP Secret Manager; "env"
   * reads `process.env` via the `NOELLE_SECRET_*` mapping (self-host). When
   * omitted, falls back to `NOELLE_SECRETS_SOURCE`.
   */
  source?: "gcp" | "env";
  /** Testing-only injection; its Promise must settle after resource cleanup. */
  client?: { accessSecretVersion: AccessFn };
  timeoutMs?: number;
  /** Serializable SDK/auth configuration; default credentials resolve inside the owned process. */
  sdkOptions?: SecretSdkOptions;
  authOptions?: GoogleAuthOptions;
}): SecretsClient {
  const project = opts.project;
  // Default TTL is intentionally short (1 minute). Workers must pick up
  // rotations from the /connections page within ~1 tick. The dashboard write
  // path adds a new Secret Manager version; cache TTL determines how soon a
  // running worker observes it. Callers that need eager invalidation should
  // call `bust(secretId)`.
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const source = resolveSource(opts.source);
  const timeoutMs = secretTimeoutMs(opts.timeoutMs);
  const client = opts.client ?? (source === "env" ? makeEnvAccessClient() : undefined);
  const access = createSecretAccessor({ ...opts, ...(client ? { client } : {}) });
  const cache = new Map<string, { value: string; expiresAt: number }>();
  const pending = new Map<string, { promise: Promise<string> }>();

  function prune(): void {
    const time = now();
    for (const [id, entry] of cache) if (entry.expiresAt <= time) cache.delete(id);
  }
  function getById(secretId: string, deadline: number): Promise<string> {
    if (performance.now() >= deadline)
      return Promise.reject(
        new SecretAccessError(`Secret access timeout reading ${secretId}`, "timeout"),
      );
    prune();
    const hit = cache.get(secretId);
    if (hit) {
      cache.delete(secretId);
      cache.set(secretId, hit);
      return Promise.resolve(hit.value);
    }
    const running = pending.get(secretId);
    if (running) return running.promise;
    try {
      access.checkAvailable();
    } catch (error) {
      return Promise.reject(error);
    }
    const claim = { promise: undefined as unknown as Promise<string> };
    claim.promise = access
      .read(`projects/${project}/secrets/${secretId}/versions/latest`, deadline)
      .then((value) => {
        if (pending.get(secretId) === claim) {
          prune();
          cache.set(secretId, { value, expiresAt: now() + ttlMs });
          while (cache.size > 256) cache.delete(cache.keys().next().value!);
        }
        return value;
      })
      .catch((error) => {
        const code = error instanceof SecretAccessError ? error.code : "failed";
        throw new SecretAccessError(
          code === "failed"
            ? `Secret access failed reading ${secretId}`
            : `${code} reading ${secretId}`,
          code,
        );
      })
      .finally(() => {
        if (pending.get(secretId) === claim) pending.delete(secretId);
      });
    pending.set(secretId, claim);
    return claim.promise;
  }

  return {
    get(name) {
      return getById(normaliseName(name), performance.now() + timeoutMs);
    },
    async getForOrg(orgId, fragment) {
      const deadline = performance.now() + timeoutMs;
      const perOrgId = `noelle--org--${orgId}--${fragment}`;
      try {
        return await getById(perOrgId, deadline);
      } catch (error) {
        if (!(error instanceof SecretAccessError) || error.code !== "NOT_FOUND") throw error;
        const legacyId = `noelle-worker-${fragment}`;
        try {
          return await getById(legacyId, deadline);
        } catch (fallbackError) {
          if (fallbackError instanceof SecretAccessError && fallbackError.code === "NOT_FOUND") {
            throw new SecretAccessError(
              `NOT_FOUND for org secret ${perOrgId} and legacy fallback ${legacyId}`,
              "NOT_FOUND",
            );
          }
          throw fallbackError;
        }
      }
    },
    async warm(names) {
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, names.length) }, async () => {
          while (next < names.length) {
            const name = names[next++]!;
            try {
              await getById(normaliseName(name), performance.now() + timeoutMs);
            } catch {
              /* Best-effort prefetch. */
            }
          }
        }),
      );
    },
    bust(secretId) {
      const id = normaliseName(secretId);
      cache.delete(id);
      pending.delete(id);
    },
  };
}

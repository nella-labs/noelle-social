/**
 * Cloud SQL Postgres data-plane client for apps/app.
 *
 * Auth path (production, on Vercel)
 * ---------------------------------
 *   x-vercel-oidc-token  (header on every function Request)
 *     │
 *     ▼
 *   ExternalAccountClient (google-auth-library)
 *     – exchanges the OIDC JWT for a GCP federated access token
 *       against the Workload Identity Pool audience, then
 *     – impersonates `vercel-noelle-app@noelle-agents.iam.gserviceaccount.com`
 *     │
 *     ▼
 *   @google-cloud/cloud-sql-connector  (authType: 'IAM')
 *     – opens an mTLS tunnel to the Cloud SQL instance and
 *       exposes a local unix socket
 *     │
 *     ▼
 *   postgres.js  (path: <socket>, user: '<sa>@<project>.iam')
 *     – IAM database authentication; no password
 *
 * The SA's Postgres role name is the SA email with the
 * `.gserviceaccount.com` suffix truncated, per Cloud SQL convention:
 *   vercel-noelle-app@noelle-agents.iam.gserviceaccount.com
 *     → vercel-noelle-app@noelle-agents.iam
 *
 * Vercel injects the OIDC token as a request header (NOT as an env var —
 * VERCEL_OIDC_TOKEN exists only at build time). The subject-token supplier
 * uses `next/headers()` to read it lazily inside the request's async
 * context. google-auth-library calls the supplier whenever it needs to
 * refresh the federated access token (~once per hour), so the header read
 * always happens during a live request, never on a background timer.
 *
 * Local dev (no NOELLE_GCP_* env vars) falls back to NOELLE_DATABASE_URL
 * (password + public IP) so `pnpm dev` keeps working unchanged.
 *
 * Phase 5 of the Supabase → Cloud SQL migration. Replaces the
 * password-over-public-IP path that shipped in phase 4. Auth still flows
 * through Supabase elsewhere; only the `noelle.*` data plane lives here.
 *
 * Connection strategy
 * -------------------
 * Vercel runs each function in its own short-lived container. `max: 1`
 * gives one connection per warm function, idle-evicted after 10s, so the
 * Cloud SQL slot ceiling (~100) stays available for the worker pool on
 * noelle-vm-0. The client + the connector are both cached on
 * `globalThis` so HMR (dev) and function-warm-reuse (prod) don't leak a
 * new pool per import.
 */

import { Connector, IpAddressTypes, AuthTypes } from "@google-cloud/cloud-sql-connector";
import { ExternalAccountClient, GoogleAuth, type AuthClient } from "google-auth-library";
import { headers } from "next/headers";
import postgres from "postgres";
import { isRetryableReadError, runWithRetry, withTimeout } from "./db-retry";

declare global {
  var __noelleSql: ReturnType<typeof postgres> | undefined;
  var __noelleConnector: Connector | undefined;
}

/**
 * Bound the otherwise-unbounded client BUILD (connector cert + WIF token
 * acquisition). When Vercel freezes the connector's cert-refresh timer (GH
 * cloud-sql-nodejs-connector#285), this acquisition hangs with no error and
 * postgres.js's connect_timeout/statement_timeout never engage (they bound a
 * client that already exists). Slightly above a healthy cold build (~1-3s) so
 * it only trips on a real hang.
 */
const CLIENT_BUILD_TIMEOUT_MS = 9000;

/**
 * Belt-and-suspenders cap on a whole tagged-query attempt (build + connect +
 * statement). Sits above the 10s connect + 8s statement budget so a legit query
 * never trips it, but bounds a request even if query-time token refresh stalls.
 * A dispatched mutation is never replayed when this deadline expires.
 */
const QUERY_ATTEMPT_TIMEOUT_MS = 20000;

/**
 * Truncate the SA email to the Postgres role name Cloud SQL exposes.
 *   `foo@bar.iam.gserviceaccount.com` → `foo@bar.iam`
 */
function saEmailToPgUser(email: string): string {
  return email.replace(/\.gserviceaccount\.com$/, "");
}

/**
 * Build an ExternalAccountClient that pulls the Vercel OIDC token at refresh
 * time. Vercel injects the token as the `x-vercel-oidc-token` header on each
 * function invocation — NOT as a process env var (that's only set at build
 * time). google-auth-library calls `getSubjectToken()` whenever it needs to
 * refresh the federated access token (~once per hour); reading the header
 * lazily inside the supplier keeps it within a request-scoped async context.
 */
function makeWifAuthClient(opts: {
  projectNumber: string;
  poolId: string;
  providerId: string;
  saEmail: string;
}) {
  const audience = `//iam.googleapis.com/projects/${opts.projectNumber}/locations/global/workloadIdentityPools/${opts.poolId}/providers/${opts.providerId}`;
  const saImpersonationUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${opts.saEmail}:generateAccessToken`;

  return ExternalAccountClient.fromJSON({
    type: "external_account",
    audience,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: saImpersonationUrl,
    subject_token_supplier: {
      getSubjectToken: async () => {
        const h = await headers();
        const token = h.get("x-vercel-oidc-token");
        if (!token) {
          throw new Error(
            "x-vercel-oidc-token header missing on request — OIDC may " +
              "not be enabled on the Vercel project, or this code path " +
              "is running outside a request context.",
          );
        }
        return token;
      },
    },
  });
}

interface ClientBuild {
  active: boolean;
  connector?: Connector;
}

function makeWifClient(): ReturnType<typeof postgres> {
  const projectNumber = process.env.NOELLE_GCP_PROJECT_NUMBER;
  const poolId = process.env.NOELLE_GCP_POOL_ID;
  const providerId = process.env.NOELLE_GCP_PROVIDER_ID;
  const saEmail = process.env.NOELLE_GCP_SA_EMAIL;
  const instance = process.env.NOELLE_CLOUDSQL_INSTANCE;

  if (!projectNumber || !poolId || !providerId || !saEmail || !instance) {
    throw new Error(
      "WIF env vars missing: need NOELLE_GCP_PROJECT_NUMBER, " +
        "NOELLE_GCP_POOL_ID, NOELLE_GCP_PROVIDER_ID, NOELLE_GCP_SA_EMAIL, " +
        "NOELLE_CLOUDSQL_INSTANCE.",
    );
  }

  // Constructing helpers must not request tokens or open sockets. Prepare the
  // one lazy pool only when its first query is observed or explicitly executed.
  let stream: (() => unknown) | undefined;
  prepareClient = async (build: ClientBuild) => {
    const authClient = makeWifAuthClient({ projectNumber, poolId, providerId, saEmail });
    if (!authClient) throw new Error("ExternalAccountClient.fromJSON returned null — WIF config invalid");
    const auth = new GoogleAuth<AuthClient>({ authClient });
    const connector = new Connector({ auth });
    build.connector = connector;
    const options = await connector.getOptions({
      instanceConnectionName: instance,
      authType: AuthTypes.IAM,
      ipType: IpAddressTypes.PUBLIC,
    });
    if (build.active && pendingBuild === build) stream = options.stream;
  };

  // The connector returns `{ stream: () => TLSSocket }` — a factory for an
  // already-mTLS-wrapped socket to Cloud SQL. postgres.js's documented
  // options expect host/port/path, not a stream factory, but its source
  // honors an undocumented `socket: () => Socket` option (see
  // postgres@3.4 src/connection.js line 132). Map stream → socket and
  // disable postgres.js's own SSL negotiation since the connector already
  // owns the TLS layer end-to-end.
  return postgres({
    // postgres.js's public types don't include `socket`; cast through
    // unknown to opt into the runtime-supported option.
    socket: () => {
      if (!stream) throw new Error("Cloud SQL client is not prepared");
      return stream();
    },
    ssl: false,
    database: "noelle",
    user: saEmailToPgUser(saEmail),
    max: 1,
    // Recycle connections well inside the connector's ~1-hour ephemeral-cert
    // window so a frozen-then-thawed Vercel instance can't reuse an expired
    // cert (GH #285). idle_timeout evicts parked sockets; max_lifetime caps a
    // long-lived warm socket at 30 min < cert TTL.
    idle_timeout: 10,
    max_lifetime: 60 * 30,
    // Fail loud on a slow/unreachable DB instead of hanging a page's render
    // (and its loading skeleton) forever: a timed-out query throws → the route
    // error boundary shows a recoverable error rather than an endless spinner.
    connect_timeout: 10,
    connection: { search_path: "noelle,public", statement_timeout: 8000 },
    onnotice: () => {},
  } as unknown as postgres.Options<Record<string, postgres.PostgresType>>);
}

function makeLocalClient(): ReturnType<typeof postgres> {
  const url = process.env.NOELLE_DATABASE_URL;
  if (!url) {
    throw new Error(
      "No DB credentials: set the WIF env quintuple (NOELLE_GCP_PROJECT_NUMBER, " +
        "NOELLE_GCP_POOL_ID, NOELLE_GCP_PROVIDER_ID, NOELLE_GCP_SA_EMAIL, " +
        "NOELLE_CLOUDSQL_INSTANCE) for Vercel runtime, or NOELLE_DATABASE_URL " +
        "for the local-dev password fallback.",
    );
  }
  // Derive SSL from the URL's sslmode. The managed fallback (Cloud SQL public
  // IP) uses `sslmode=require`; a self-hosted local Postgres offers no TLS and
  // passes `sslmode=disable`. Anything other than `disable` keeps requiring SSL,
  // so prod behaviour is unchanged.
  const ssl = /[?&]sslmode=disable\b/.test(url) ? false : "require";
  return postgres(url, {
    max: 1,
    idle_timeout: 10,
    max_lifetime: 60 * 30,
    ssl,
    // See makeWifClient: bound query/connect time so a slow DB throws (→ a
    // recoverable error page) instead of hanging the render indefinitely.
    connect_timeout: 10,
    connection: { search_path: "noelle,public", statement_timeout: 8000 },
    onnotice: () => {},
  });
}

/**
 * Lazy singleton. The client is built on the FIRST tagged-template call,
 * not at module load — Next.js loads every page module during
 * `next build` for static analysis, and at that moment we have neither
 * the WIF env vars nor NOELLE_DATABASE_URL. Throwing then breaks the build.
 * Throwing on first real query (in the request lifecycle, where env is
 * populated) is correct.
 *
 * Path selection: presence of the WIF env-var quintuple is the signal for
 * "this is a Vercel runtime configured for WIF" — once that's true, we do
 * NOT fall back to NOELLE_DATABASE_URL on failure. Silent password fallback
 * is what hid the broken WIF path for 9 days; failing loud beats failing
 * encrypted.
 */
let pendingClient: Promise<ReturnType<typeof postgres>> | null = null;
let resolvedClient: ReturnType<typeof postgres> | null = null;
let pendingBuild: ClientBuild | null = null;
let lazyClient: ReturnType<typeof postgres> | null = null;
let prepareClient: ((build: ClientBuild) => Promise<void>) | undefined;
const readReconnects = new WeakMap<ReturnType<typeof postgres>, number>();
let readReconnectVersion = 0;

function wifEnvPresent(): boolean {
  return Boolean(
    process.env.NOELLE_GCP_PROJECT_NUMBER &&
      process.env.NOELLE_GCP_POOL_ID &&
      process.env.NOELLE_GCP_PROVIDER_ID &&
      process.env.NOELLE_GCP_SA_EMAIL &&
      process.env.NOELLE_CLOUDSQL_INSTANCE,
  );
}

function getLazyClient(): ReturnType<typeof postgres> {
  if (resolvedClient) return resolvedClient;
  if (globalThis.__noelleSql) return (resolvedClient = globalThis.__noelleSql);
  return lazyClient ??= wifEnvPresent() ? makeWifClient() : makeLocalClient();
}

function getClient(): Promise<ReturnType<typeof postgres>> {
  if (resolvedClient || globalThis.__noelleSql) return Promise.resolve(getLazyClient());
  if (!pendingClient) {
    const build: ClientBuild = { active: true };
    pendingBuild = build;
    // Defer factories until pendingClient is assigned, so synchronous failure
    // cannot reinstall a rejected acquisition promise. Preparation generations
    // share the unopened pool; only their unpublished connectors are disposable.
    pendingClient = Promise.resolve().then(async () => {
      const client = getLazyClient();
      await withTimeout(Promise.resolve().then(() => prepareClient?.(build)), CLIENT_BUILD_TIMEOUT_MS, "cloud-sql client build");
      if (!build.active || pendingBuild !== build) throw new Error("Database client build was superseded");
      resolvedClient = client;
      globalThis.__noelleSql = client;
      globalThis.__noelleConnector = build.connector;
      pendingBuild = null;
      return client;
    }).catch((error) => {
      build.active = false;
      try { build.connector?.close(); } catch { /* unpublished connector cleanup */ }
      if (pendingBuild === build) {
        pendingBuild = null;
        pendingClient = null;
      }
      throw error;
    });
  }
  return pendingClient;
}

function acquireClient(): Promise<ReturnType<typeof postgres>> {
  return runWithRetry(getClient, { reset: () => {}, label: "cloud-sql client acquisition" });
}

type NativeQuery = postgres.PendingQuery<postgres.Row[]>;

/** Keep the native Query prototype so embedded fragments remain fragments. */
function pendingQuery(query: NativeQuery): NativeQuery {
  let result: Promise<postgres.RowList<postgres.Row[]>> | undefined;
  const dispatch = () => result ??= acquireClient().then(() =>
    withTimeout(Promise.resolve(query), QUERY_ATTEMPT_TIMEOUT_MS, "cloud-sql query"),
  );
  const proxy = new Proxy(query, {
    get(target, property, receiver) {
      if (property === "then" || property === "catch" || property === "finally") {
        return (...args: unknown[]) => Reflect.apply(Reflect.get(dispatch(), property), result, args);
      }
      // Native execute/forEach/cursor use this.handle(). Gate that same entry
      // point and keep their native chain/iterator receivers intact.
      if (property === "handle") return dispatch;
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || property === "constructor") return value;
      return (...args: unknown[]) => Reflect.apply(value, receiver, args);
    },
  });
  return proxy;
}

// Helpers construct synchronous native builders from the same lazy pool. A
// query observes one cached, bounded dispatch; merely embedding it does no I/O.
export const sql = new Proxy(function () {} as unknown as ReturnType<typeof postgres>, {
  get(_target, property) {
    if (property === "begin") return (...args: unknown[]) => acquireClient().then((client) =>
      withTimeout(Reflect.apply(client.begin, client, args), QUERY_ATTEMPT_TIMEOUT_MS, "cloud-sql transaction"),
    );
    if (property === "unsafe" || property === "file") return (...args: unknown[]) =>
      pendingQuery(Reflect.apply(Reflect.get(getLazyClient(), property), getLazyClient(), args));
    // No application caller uses listener/subscription/streaming owners. These
    // dispatching pool methods must still prepare before entering the driver.
    if (property === "reserve" || property === "listen" || property === "notify" || property === "subscribe" || property === "largeObject") {
      return (...args: unknown[]) => acquireClient().then((client) =>
        withTimeout(Reflect.apply(Reflect.get(client, property), client, args), QUERY_ATTEMPT_TIMEOUT_MS, "cloud-sql operation"),
      );
    }
    const client = getLazyClient();
    const value = Reflect.get(client, property);
    return typeof value === "function" ? value.bind(client) : value;
  },
  apply(_target, _receiver, args) {
    const first = args[0];
    const tagged = Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, "raw");
    if (!tagged) return Reflect.apply(getLazyClient(), undefined, args);
    return pendingQuery(Reflect.apply(getLazyClient(), undefined, args));
  },
}) as ReturnType<typeof postgres>;

/** One query in an enforced READ ONLY transaction; only these dispatches may retry. */
export async function readSql<T extends readonly (object | undefined)[] = postgres.Row[]>(
  template: TemplateStringsArray,
  ...parameters: readonly postgres.ParameterOrFragment<never>[]
): Promise<postgres.RowList<T>> {
  return runWithRetry(async () => {
    const client = await acquireClient();
    // After a disconnect, let the driver's ordinary query lifecycle reconnect
    // before reserving. postgres.js 3.4.9 can strand a reconnecting reservation
    // after an active query's FATAL response; this fixed literal has no writes.
    const reconnect = readReconnects.get(client);
    if (reconnect !== undefined) {
      await client`select 1`;
      if (readReconnects.get(client) === reconnect) readReconnects.delete(client);
    }
    let connection: postgres.ReservedSql | undefined;
    let inTransaction = false;
    let disconnected = false;
    try {
      connection = await client.reserve();
      // Explicit reservation avoids postgres.js begin() trying to ROLLBACK a
      // disconnected socket. All commands use this same reserved connection.
      await connection`begin read only`;
      inTransaction = true;
      await connection`set local idle_in_transaction_session_timeout='10s'`;
      const rows = await connection<T>(template, ...parameters);
      await connection`commit`;
      inTransaction = false;
      return rows;
    } catch (error) {
      // Server statement errors leave a healthy transaction needing rollback.
      // Transport failures belong to the driver's socket disposal lifecycle.
      disconnected = isRetryableReadError(error);
      if (disconnected) readReconnects.set(client, ++readReconnectVersion);
      if (connection && inTransaction && !disconnected) {
        try { await connection`rollback`; } catch { /* preserve the query failure */ }
      }
      throw error;
    } finally {
      // postgres.js onclose already releases a disconnected reservation.
      // Calling its public release afterward would move a closed socket back
      // into the open queue. Healthy connections still release explicitly.
      if (!disconnected) connection?.release();
    }
  }, {
    reset: () => {},
    isRetryable: isRetryableReadError,
    timeoutMs: QUERY_ATTEMPT_TIMEOUT_MS,
    label: "cloud-sql read-only query",
  }) as Promise<postgres.RowList<T>>;
}

/**
 * Run a callback inside a transaction. Thin wrapper over `sql.begin` that
 * bounds acquisition/dispatch and preserves the driver's read-committed
 * default. Dispatched callbacks and commits are never automatically replayed.
 */
export async function withTx<T>(
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(fn) as Promise<T>;
}

/**
 * Adapter so the existing `assertOrgMember` guard from `@noelle/runtime`
 * (which today takes a Supabase-shaped `OrgMembersQueryClient`) can run
 * against postgres.js without rewriting that package or duplicating the
 * `org_members` lookup logic here.
 *
 * The shape `assertOrgMember` actually exercises is a single read:
 *   `select user_id from noelle.org_members where org_id = $1 and user_id = $2`
 * — we mimic the Supabase chain (`.from(...).select(...).eq(...).eq(...)
 *   .maybeSingle()`) just enough to satisfy the structural type, and run
 * the equivalent SQL when `.maybeSingle()` is finally invoked.
 */
export function pgOrgMembersClient() {
  return {
    from(_table: "org_members") {
      return {
        select(_columns: string) {
          let orgId: string | null = null;
          let userId: string | null = null;
          const setEq = (column: "org_id" | "user_id", value: string) => {
            if (column === "org_id") orgId = value;
            else userId = value;
          };
          const runner = {
            async maybeSingle() {
              if (!orgId || !userId) {
                return {
                  data: null,
                  error: { message: "missing org_id/user_id in guard query" },
                };
              }
              try {
                const rows = await readSql<{ user_id: string }[]>`
                  select user_id
                  from noelle.org_members
                  where org_id = ${orgId} and user_id = ${userId}
                  limit 1
                `;
                if (rows.length === 0) return { data: null, error: null };
                return { data: { user_id: rows[0].user_id }, error: null };
              } catch (err) {
                return {
                  data: null,
                  error: { message: (err as Error).message },
                };
              }
            },
          };
          const second = {
            eq(column: "org_id" | "user_id", value: string) {
              setEq(column, value);
              return runner;
            },
          };
          return {
            eq(column: "org_id" | "user_id", value: string) {
              setEq(column, value);
              return second;
            },
          };
        },
      };
    },
  };
}

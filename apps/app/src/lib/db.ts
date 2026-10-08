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

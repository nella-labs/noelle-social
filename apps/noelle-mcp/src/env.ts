import { z } from "zod";

// Truthy env flag ("1"/"true", case-insensitive). Unset → false.
// (z.coerce.boolean is unsafe — Boolean("false") is true.) Mirrors the helper
// in apps/api-vm/src/env.ts so flag semantics match the rest of the repo.
const boolFlag = z
  .string()
  .optional()
  .transform((v) => v === "1" || (v ?? "").toLowerCase() === "true");

// The MCP server is an OPERATOR tool: whoever runs it holds NOELLE_DATABASE_URL
// (Cloud SQL role `noelle_app` — full CRUD on noelle.*, no RLS). There is no
// per-request user, so tenancy is enforced by locking every query to a single
// configured org (NOELLE_MCP_ORG) rather than by assertOrgMember. See README.
const EnvSchema = z.object({
  // Cloud SQL Postgres 16, same connection string apps/api-vm uses. Shape:
  //   postgres://noelle_app:PASSWORD@HOST:5432/noelle?sslmode=require
  // With a Lima VM this typically points at a host-forwarded port or the
  // Cloud SQL Auth Proxy.
  NOELLE_DATABASE_URL: z.string().min(1),

  // Default org for tools that don't get an explicit `org` argument. Accepts a
  // slug ("team") or a uuid. Optional — without it, tools require an `org`
  // arg and noelle_list_orgs still works to discover options.
  NOELLE_MCP_ORG: z.string().optional(),

  // Refuse every write/mutation tool when set. A safety belt for pointing the
  // server at production while you explore.
  NOELLE_MCP_READONLY: boolFlag,

  // Optional api-vm delegation. When set, side-effecting actions (draft send,
  // ideation, generate) can call the live api-vm instead of writing queue rows
  // directly. Without it, those tools fall back to direct-DB status writes that
  // the systemd workers drain.
  NOELLE_API_BASE_URL: z.string().url().optional(),

  // A ready-made Bearer token (Supabase or operator JWT) for api-vm. Preferred
  // over minting. If absent, an operator JWT is minted from
  // NOELLE_SUPABASE_JWT_SECRET when that + NOELLE_MCP_OPERATOR_SUB are present.
  NOELLE_MCP_API_TOKEN: z.string().optional(),
  NOELLE_SUPABASE_JWT_SECRET: z.string().optional(),

  // The Supabase user id (auth.users.id / JWT `sub`) this operator acts as.
  // Used as `decided_by` on approvals and as the `sub` claim when minting an
  // api-vm token. Defaults to a sentinel when unset.
  NOELLE_MCP_OPERATOR_SUB: z.string().optional(),

  // Per-statement timeout guard for the DB connection.
  NOELLE_MCP_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(8000),

  // Seconds to wait for a DB CONNECTION before giving up. Distinct from
  // STATEMENT_TIMEOUT, which only bounds a query once it is already executing.
  // Without this, a connection-level stall (Postgres restarting, pooled sockets
  // killed by a deploy) makes a tool call hang indefinitely instead of failing
  // fast — the MCP client then reports "No result received ... after waiting N
  // minutes", which reads as a crashed server and sends the operator hunting in
  // the wrong place. Fail fast with a legible error instead.
  NOELLE_MCP_CONNECT_TIMEOUT_S: z.coerce.number().int().min(1).default(10),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  cached = EnvSchema.parse(process.env);
  return cached;
}

export function resetEnvForTests() {
  cached = undefined;
}

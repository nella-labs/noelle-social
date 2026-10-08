/**
 * @noelle/types
 *
 * Re-exports of the generated Supabase types so downstream packages can
 * `import type { Database, Tables, Enums } from '@noelle/types'`.
 *
 * To regenerate from the configured Supabase project:
 *   SUPABASE_PROJECT_REF=<project-ref> pnpm --filter @noelle/types generate
 *
 * CI does not regenerate — the committed src/database.ts is the source of
 * truth between migrations and consumer packages. Regenerate locally after
 * every schema migration and commit the result.
 *
 * See docs/supabase-contract.md for the schema and the generation command.
 */

export * from "./database.js";
export type { Database } from "./database.js";

import type { Database } from "./database.js";

// Convenience aliases mirroring what supabase-js suggests in its docs. The
// extra `extends { Row, Insert, Update }` guard keeps tsc happy on schemas
// (like `public`) where the Tables map is empty in this snapshot.
type TableDef = { Row: unknown; Insert: unknown; Update: unknown };

export type Tables<
  Schema extends keyof Database,
  T extends keyof Database[Schema]["Tables"]
> = Database[Schema]["Tables"][T] extends TableDef
  ? Database[Schema]["Tables"][T]["Row"]
  : never;

export type TablesInsert<
  Schema extends keyof Database,
  T extends keyof Database[Schema]["Tables"]
> = Database[Schema]["Tables"][T] extends TableDef
  ? Database[Schema]["Tables"][T]["Insert"]
  : never;

export type TablesUpdate<
  Schema extends keyof Database,
  T extends keyof Database[Schema]["Tables"]
> = Database[Schema]["Tables"][T] extends TableDef
  ? Database[Schema]["Tables"][T]["Update"]
  : never;

// 0.0.1: noelle.* aliases. Lift to a generic helper when 0.1.0 adds more schemas.
export type Organization = Tables<"noelle", "organizations">;
export type OrgMember = Tables<"noelle", "org_members">;
export type AgentInstance = Tables<"noelle", "agent_instances">;
export type Lead = Tables<"noelle", "leads">;
export type Draft = Tables<"noelle", "drafts">;
export type Approval = Tables<"noelle", "approvals">;
export type OrgSpendMonth = Tables<"noelle", "org_spend_month">;
export type SyncRun = Tables<"noelle", "sync_runs">;

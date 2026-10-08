# @noelle/types

Shared generated TypeScript database types. Consumers import the canonical `Database` type and table aliases from this package.

For a configured Supabase installation, set `SUPABASE_PROJECT_REF` and run `pnpm --filter @noelle/types generate`. Keep credentials in the CLI's authenticated session, outside git. CI builds the checked-in types; it does not query a remote database.

The current PostgreSQL migrations remain the source of truth for product schema changes. See [the database contract](../../docs/database-contract.md) and [architecture](../../docs/architecture.md).

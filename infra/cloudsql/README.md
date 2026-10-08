# PostgreSQL schema and legacy hosted infrastructure

`schema/` contains the canonical PostgreSQL migration files used by the managed CLI. The directory name reflects the original hosted deployment; native installations apply these migrations to their own PostgreSQL database.

Use `node apps/cli/dist/index.js migrate` for an initialized installation. It applies filenames in order and records the ledger. Keep historical filenames stable. Personal historical seed bodies are no-ops; fresh operator and social-profile seeding belongs to initialization.

The application role is separate from the migration administrator. App queries and workers enforce tenant ownership at their existing boundaries. Remote hosting requires the operator's own project, network, TLS and secrets configuration.

See [setup](../../docs/self-host.md), [the database contract](../../docs/database-contract.md), [hosted capacity](../../docs/cloudsql-scaling.md) and [the runbook](../../docs/runbook.md).

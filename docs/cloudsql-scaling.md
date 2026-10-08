# Hosted PostgreSQL capacity

Native installations use their configured PostgreSQL instance. Cloud SQL is an optional hosting choice represented by the legacy infrastructure in this repository; its project, region, network and credentials must be supplied by the operator.

## Measure before changing capacity

Inspect connection utilization, query latency, lock waits, storage growth and worker claim backlog. Attribute load to the dashboard, API or a worker lane before changing instance capacity.

Provider budgets and platform action limits remain independent of database capacity. Increasing worker concurrency can raise both database load and external spend.

## Connection and tenancy contract

Use a restricted application role for product access and a separate administrator connection for migrations. Protect remote connections with the hosting provider's supported TLS and network controls. Keep connection strings and credentials outside tracked files.

App-layer membership and worker ownership checks remain required when running direct PostgreSQL. A hosting provider does not add the product's organization checks automatically.

If pooling is required, verify compatibility with the current transaction, session and prepared-statement behavior. Bound pools across all processes; a per-process setting is multiplied by the worker count.

## Change procedure

1. Back up the database and record the restore target.
2. Verify the current schema ledger and application version.
3. Apply a capacity or topology change through the hosting provider's supported process.
4. Verify read-only health, a bounded query and worker claims before raising concurrency.
5. Preserve the documented rollback path until the change is confirmed.

Do not copy a production project's identifiers or authorized network addresses into a new installation. See [the runtime runbook](runbook.md), [secrets](secrets.md) and [testing](testing.md).

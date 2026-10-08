# Scalability

Noelle keeps tenant ownership and bounded work at the existing runtime, database and platform owners. Scale the measured bottleneck while preserving those contracts. See [architecture](architecture.md) and [the database contract](database-contract.md).

## Tenant and account boundaries

App entry points verify organization membership before accessing workspace data. Workers resolve their profile, organization and account before claiming work. Queries, cached results, context retrieval and provider connection pools must retain that scope.

A new account or workspace must not inherit another tenant's context, secret, sender session or defaults. Tests should cover missing configuration and cross-tenant access as well as the successful path.

## Worker concurrency

Discovery, classification, drafting and publication have separate lanes. Worker count, lane enablement and profile status are independent. Increase concurrency only after checking database capacity, provider budgets and platform action limits.

Keep claims atomic and bounded. Use existing shared claim primitives and unique constraints rather than a second queue owner. Recheck mutable consent and safety gates before an external action. Reconcile uncertain receipts before repeating a send.

## Reads and storage

Use explicit limits and pagination for growing inboxes, contacts, activity and history. Keep result windows stable across refreshes. Scope counts and rollups to the workspace and distinguish absent measurements from zero.

Database indexes should match the current filters, join keys and claim order. Measure slow queries and connection pressure before adding a cache or another database service. Retention changes need an explicit policy and must preserve receipts, approval history and required audit evidence.

## Shared ownership

- `packages/runtime` owns shared work claims, retrieval, routing, budget and tenancy contracts.
- `packages/contracts` owns cross-package payloads and role/capability identifiers.
- Platform workers and actuators own their platform-specific behavior.
- App components own reusable controls, states and layout; pages compose them.
- Managed CLI commands own deployment state, locks and runtime configuration.

Replace an owner by migrating its callers and removing the old copy. Do not add a parallel helper for the same business rule.

## Validation

Run affected package tests, typechecks and production builds. Exercise empty, loading, failure, pagination and tenant-denied states. Use disposable databases and fake provider clients for destructive or external-action cases.

`pnpm lint:sst` currently runs a placeholder check. It does not prove architecture boundaries. The relevant imports, shared callers, tests and runtime behavior remain part of validation. See [testing](testing.md).

# @noelle/runtime

Shared agent routing, spend limits, tenant data access and provider adapters.
Workers import feature modules through the package subpaths.

Child process lifetime and deadline admission belong to `@noelle/process`.
The runtime CLI exports preserve the same interface. Secret retrieval and its
cache belong to `@noelle/secrets`; neither lower package depends on runtime.

Run `pnpm turbo test --filter=@noelle/runtime` to build dependencies and the
compiled SDK workers before exercising native process tests.
See [the architecture map](../../docs/architecture.md) for ownership and
[the agent contract](../../docs/agent-model.md) for worker integration.

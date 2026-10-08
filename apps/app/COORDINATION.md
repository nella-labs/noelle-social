# Dashboard module boundaries

The Next.js dashboard lives in `src/app`. Route pages compose product views; shared controls and states belong in `src/components`. Database queries, authentication and platform helpers have owners in `src/lib`.

Use `@noelle/contracts` for cross-service payloads and `@noelle/runtime` for shared product rules. Keep workspace membership checks at server entry points. Local operator authentication and verified hosted sessions are separate modes.

The dashboard exposes social profiles and their discovery, drafting, review, publication and measurement workflows. Configure a profile through its existing owner rather than adding a management hierarchy or a second send path.

Reuse navigation, theme tokens, buttons, filters and loading/error/empty states. When replacing an owner, migrate its callers and remove the replaced copy.

See [contributing](../../CONTRIBUTING.md), [architecture](../../docs/architecture.md) and [testing](../../docs/testing.md) for setup and validation.

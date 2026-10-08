# Repository guide

Noelle is a social growth workspace for X, LinkedIn, Reddit and video channels. Read [docs/product.md](docs/product.md) and [docs/architecture.md](docs/architecture.md) before changing behavior.

## Development

- Follow [CONTRIBUTING.md](CONTRIBUTING.md) and use an isolated branch or worktree.
- Pages compose feature components. Shared controls belong in the app's UI modules; cross app contracts and rules belong in shared packages.
- Search for an existing owner before adding a utility or component. Migrate callers and remove replaced copies when consolidating code.
- Preserve verified authentication, organization membership and current object ownership checks.
- Bound queries, provider calls, process work, retries and concurrency.
- Verify affected consumers with the checks in [docs/testing.md](docs/testing.md). Keep live social actions outside routine tests.

## Documentation and delivery

Use fictional examples and describe observed behavior directly. Keep credentials, personal runtime state and private working notes out of source, logs and public artifacts. Preserve required licenses and notices.

Runtime installations are managed by the CLI. Read [docs/runbook.md](docs/runbook.md) before operating one. A build or queued request alone does not prove a deployment or social action succeeded.

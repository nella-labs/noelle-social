# Contributing

Noelle focuses on social growth: conversations, content, contacts, platform profiles, review and measured results. Contributions should fit those workflows.

## Before changing code

Read the [product guide](docs/product.md), [architecture](docs/architecture.md) and [developer setup](docs/testing.md). Search existing issues and code owners before adding another component or service. For a change to a shared contract, identify its affected consumers first.

Use an issue for a reproducible bug or a proposed feature. Include the relevant workflow, expected behavior and actual result. Keep account data and credentials out of screenshots, logs and examples.

## Pull requests

1. Fork the repository and make a focused branch.
2. Keep feature rules near their feature and use existing shared controls and contracts.
3. Add tests for changed behavior. Update documentation when setup or user behavior changes.
4. Run the checks in [docs/testing.md](docs/testing.md).
5. Explain the problem, resulting behavior, validation and any known limitation in the pull request.

Use small commits with clear messages. Keep implementation and test changes in separate commits. A pull request should have one purpose. Avoid unrelated formatting or dependency changes.

Sending a social message is a real action. Use fixtures, disposable databases and mocked provider boundaries for tests. Live verification requires an explicitly configured test account and a deliberate send decision.

## Project rules

- Keep organization membership and current object ownership checks on reads and writes.
- Bound queries, external requests, retries and concurrent work.
- Preserve uncertain delivery results. Do not retry a write merely because its response timed out.
- Reuse shared presentation and business rules, then migrate callers and remove replaced copies.
- Use fictional data in examples and retain required third party notices.

Contributions are accepted under the [MIT license](LICENSE). Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through the process in [SECURITY.md](SECURITY.md).

# Developer setup and tests

Use Node 22 and pnpm 10.28.0, as pinned in `.nvmrc` and `package.json`. Install the frozen lockfile in an isolated checkout.

```sh
pnpm install --frozen-lockfile
pnpm ci:local
```

`ci:local` runs the repository's affected validation against `origin/main`. `pnpm ci:full` validates every workspace. It installs dependencies, runs Turbo typecheck, lint, build and tests, then the root checks and CI self tests. `--skip-install` is available when dependencies are already installed.

## Focused validation

```sh
pnpm exec turbo run build typecheck lint test --filter=@noelle/app
pnpm exec turbo run build typecheck test --filter=@noelle/cli
pnpm exec turbo run build typecheck test --filter=@noelle/runtime
pnpm lint:reply-variation
pnpm lint:sst
```

Turbo builds dependency outputs before their consumers. Dashboard typecheck also depends on the dashboard build because Next.js generates route types. A direct package command does not build its dependencies automatically.

Tests use Vitest and are generally colocated with source. The dashboard's configuration includes `src/**/*.test.ts`; component tests select a DOM environment where needed. Module boundaries mock external providers and social writes.

`lint:sst` currently exits successfully as a placeholder. Its pass does not prove component reuse or architecture quality. Review ownership, dependency direction, caller migration and duplication separately.

## Database integration tests

Integration suites require their own feature specific test database variables. Examples include `NOELLE_TEST_DATABASE_URL`, `NOELLE_DASHBOARD_CONTROLS_TEST_DATABASE_URL` and `NOELLE_ONBOARDING_INVITE_TEST_DATABASE_URL`.

Use disposable PostgreSQL databases for those variables. Several suites recreate schemas or seed and delete rows. Never point a test variable at an operational database. Without the relevant variable, that suite skips its database cases; a unit test pass does not prove them.

## Dashboard verification

Run development on a separate port from any managed installation:

```sh
pnpm --filter @noelle/app exec next dev --webpack --port 3101
```

Next.js 16 uses the documented Webpack scripts because existing explicit `.js` imports depend on the configured resolver. Supply the development environment for your own disposable or private test installation. Follow [self hosting](self-host.md) for local operator setup.

Check affected routes at desktop, tablet and phone widths. Include light and dark themes, keyboard focus, loading and error states, filters, pagination and the controls changed by the patch. Use fictional data and avoid live Send, Approve, scheduling, connection or worker actions during visual checks.

There is no checked in Playwright end to end suite or browser fixture harness. Do not describe a browser screenshot, successful build or mocked component test as a full platform delivery test.

## CI and contributions

`.github/workflows/ci.yml` runs one required workspace validation job. Pull requests validate affected packages; pushes to `main` or `codex/public-release` validate all packages. Hosted CI availability depends on repository configuration. Use local validation when hosted execution is unavailable, and state that limitation.

Follow [CONTRIBUTING.md](../CONTRIBUTING.md). A validation report should identify what ran, what passed and any skipped environment dependent layer.

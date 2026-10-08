# Self hosting

Run the dashboard, API and social workers with your own PostgreSQL database and provider credentials. Local operator authentication uses one configured identity. Keep it on a private host or network.

## Prerequisites

- Node 22 and pnpm 10.28.0.
- Docker or nerdctl for container PostgreSQL, or an existing PostgreSQL 16 instance.
- A checked out copy of this repository.
- Credentials for the providers and social accounts you choose to connect.

## Install

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@noelle/cli
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js init --provider anthropic --email operator@example.com --org team
node apps/cli/dist/index.js up
```

Supply `ANTHROPIC_API_KEY` in the process environment before `init`. The CLI collects it into its private runtime configuration. `init` provisions the database, applies migrations, seeds the configured operator and platform profiles, and writes runtime configuration. It changes state.

Open [http://127.0.0.1:3001](http://127.0.0.1:3001). The default API port is 18791. Use `--port-app` and `--port-api` during `init` if those ports are already in use.

For an existing native PostgreSQL server, set `NOELLE_PG_SUPERUSER_URL` to your local administrator connection string and add `--pg native`. The CLI needs that access to create its application role and apply schema changes. A new installation should use a separate database.

## Providers

`init --provider` accepts `anthropic`, `openai`, `bedrock`, `vertex` or `codex`.

| Provider | Setup before initialization |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Bedrock | `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` |
| Vertex | `GOOGLE_APPLICATION_CREDENTIALS` pointing to your credential file |
| Codex | An installed CLI with its own authenticated session |

Provider configuration is separate from social account access. Connected discovery may also require Apify or a supported account reader. Each platform's sender has its own permission and credential requirements.

## Workers and publication

Worker processes are disabled by default. To enable the worker processes, initialize with `--workers`, then run `up`. Existing saved configuration keeps its selected settings.

```sh
node apps/cli/dist/index.js init --provider anthropic --email operator@example.com --org team --workers
node apps/cli/dist/index.js up
```

Use Settings → Channels to configure each platform's objective, audience, budgets and lanes. Enable only the work you intend to run. Initial platform profiles have publication disabled. Publication also requires the platform's current account access, consent and sender gates. A running drafter alone does not send content.

## Brand context and files

`brand init` creates the installation's brand questionnaire. Edit it, then use `brand apply` to apply the supported fields. You can inspect them with `brand show`.

Use `init --vault-dir /path/to/context` for a local context folder. `--voice-dirs` accepts comma separated paths relative to that folder, so unrelated notes do not become writing evidence. Saved tenant context or an explicitly configured external workspace supplies retrieval; there is no shared personal workspace fallback.

## Operate the installation

```sh
node apps/cli/dist/index.js status
node apps/cli/dist/index.js health
node apps/cli/dist/index.js logs noelle-app
node apps/cli/dist/index.js migrate
node apps/cli/dist/index.js down
```

`down --purge` removes container data. Keep backups before using it. `up --build` rebuilds the configured stack. `sync` is the managed update path; [the runbook](runbook.md) explains its safeguards.

Runtime state lives in `~/.noelle` by default. `NOELLE_HOME` selects another installation directory. Keep its environment file, signing secrets, backups and logs out of git. Do not reuse another installation's secrets.

Automatic updates are optional. On macOS, select the branch to follow explicitly:

```sh
node apps/cli/dist/index.js autoupdate install --branch codex/public-release
node apps/cli/dist/index.js autoupdate status
```

The public repository's default branch is `codex/public-release`. Use your own maintained branch for a fork. Installation preserves the saved branch when `--branch` is omitted.

## Hosted access

Supabase session mode supports verified users and organization membership checks. It needs separately configured session, database and gate settings. Set `NOELLE_PRIMARY_ADMIN_EMAIL` to the hosted installation owner for restricted administration. Local mode falls back to the configured operator identity. Local operator mode does not authenticate several users.

Remote access tools can expose the local endpoint. Keep that endpoint private unless an authentication boundary protects it. Read [SECURITY.md](../SECURITY.md) before sharing access.

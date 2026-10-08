# Deploy the dashboard

For a complete installation, follow the [self-hosting guide](../../docs/self-host.md). The dashboard needs the Noelle API and database; deploying the web app alone does not start channel workers.

## Vercel

Import your repository with `apps/app` as the root directory. Include files outside that directory so workspace packages resolve. The build settings are in [vercel.json](vercel.json): install with `pnpm install --frozen-lockfile` and build with `pnpm exec turbo run build --filter=@noelle/app`.

Configure production and preview environments independently. For hosted authentication, use your own Supabase project and invitation allowlist.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your project's public authentication key |
| `NEXT_PUBLIC_APP_URL` | Dashboard origin used by invitation emails |
| `NOELLE_API_BASE_URL` | Reachable Noelle API origin |
| `NOELLE_DATABASE_URL` | Database connection for server-side workspace reads |
| `NOELLE_PRIMARY_ADMIN_EMAIL` | Verified account allowed to manage workspace invitations |

Configure the remaining API and session credentials described in the self-hosting guide. Keep server credentials out of `NEXT_PUBLIC_*` variables. For a local installation, use the CLI's local authentication setup instead of hosted invitations.

After deployment, open the login and About pages, sign in, and check Overview, Engage, Content, People, and Settings. Confirm reads use your workspace and that channel publication stays disabled until you configure and approve it. Check the spend-sync cron only when the API and its credentials are configured.

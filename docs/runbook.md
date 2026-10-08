# Runtime operations

Operate the configured installation through the CLI. Use [self hosting](self-host.md) for initial setup and [testing](testing.md) for development validation.

## Inspect first

```sh
node apps/cli/dist/index.js status
node apps/cli/dist/index.js health
node apps/cli/dist/index.js deploy status
node apps/cli/dist/index.js autoupdate status
node apps/cli/dist/index.js logs noelle-app
```

Default local endpoints are the dashboard at `127.0.0.1:3001` and API health at `127.0.0.1:18791/health`. The managed process manifest, configuration and live process state identify the actual ports and services.

Runtime state lives in `~/.noelle`, or the configured `NOELLE_HOME`. The `.noelle-deployed` stamp records the successful build SHA and time. A deploy lock identifies an active update. Compare those with the checkout HEAD before claiming a version is live.

## Update

`sync` is the managed update path. An automatic tick fetches the configured branch and fast forwards only when local work is safe. It applies pending migrations, builds the workspace, restarts managed services and checks health before advancing the build stamp.

```sh
node apps/cli/dist/index.js sync
```

Automatic updates are optional and configured through `autoupdate install`. On a native macOS installation, the LaunchAgent runs at the selected interval while the host is available. `autoupdate status` reports its loaded state and recent log.

Manual `deploy` ships the configured working tree without pulling. Its force option bypasses a deployment hold or lock recovery check. Use it only as a deliberate operator action after inspecting the active state. Avoid separate builds or process restarts that bypass the managed update lifecycle.

A failed automatic deployment keeps the last successful build stamp. Repeated failures of the same SHA are bounded; inspect its recorded error before retrying. Configure an alert command if unattended failures need external notification.

## Start and stop

```sh
node apps/cli/dist/index.js up
node apps/cli/dist/index.js down
```

`down` records a deliberate stop. Automatic recovery preserves that choice. `up` clears the stop marker and starts the configured stack. Container purge removes its data and needs a verified backup first.

A healthy root endpoint proves HTTP availability. It does not prove that a platform connection, drafting worker, account sender or queued request works. Verify those through their current worker runs, source records, requests and delivery receipts.

## Worker and account diagnosis

1. Confirm the configured profile and enabled lane.
2. Confirm its worker process exists and is running.
3. Inspect the recent worker run and its recorded reason or error.
4. Check the owned source, lead, draft, approval or request rows.
5. Inspect account access and sender gates without printing credentials.
6. Read the platform receipt before treating a send as complete.

A queued request can remain pending while a worker is unavailable. A timeout can leave a send outcome unknown. Preserve that state and inspect the platform before admitting a duplicate.

## Backups and recovery

Back up the configured database and file storage. Store backups and signing secrets outside the repository. Test restoration in an isolated installation before relying on a backup.

A rollback requires matching application code, migrations and stored contracts. Retained migration filenames are part of the ledger. Do not rename an applied migration merely to change a description.

## Hosted deployments

A hosted dashboard may use a separate build platform and verified session provider. Inspect that platform's deployment revision, build result, runtime health and authenticated UI independently from a local installation.

Legacy cloud and Supabase workflows remain optional infrastructure. Their configuration is not proof of the current installation's active runtime.

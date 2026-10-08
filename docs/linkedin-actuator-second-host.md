# Running an actuator on a second host

A browser actuator can run on a different private host from the API and database. Configure that installation's backend address, account session and extension options explicitly. The API host's loopback address is not reachable from the second host.

## Account ownership

Use one active sender session for a connected account. Keep a standby extension disarmed and do not run it while the primary host is sending. Deduplication helps prevent repeated actions but does not coordinate two independent browsers.

Before switching hosts, stop the primary run and confirm that it has no action in flight. Reconcile uncertain receipts before enabling the replacement.

## Build and connection

1. Set `NOELLE_ACTUATOR_API_ORIGINS` to comma separated specific HTTP(S) backend origins, then build the actuator through the managed installation or package build command. The shared manifest owner retains local hosts and rejects broad wildcards, credentials and path URLs.
2. Copy the resulting `apps/<platform>-actuator/dist-unpacked` directory to a dedicated directory on the second host. Use a private authenticated connection. Do not replace a working extension with an empty or partial build.
3. Load that directory as an unpacked extension in the supported browser.
4. Configure the extension's API base URL, installation token and profile instance ID in its options page. Keep tokens outside repository files and sync scripts.
5. Ensure the backend host is permitted by the extension manifest and protected by the API's authentication boundary. Restrict network access to the intended hosts.
6. Reload the extension and its target tab after updating copied files. A directory copy alone does not activate new code.

The sync helper requires `NOELLE_MAC_USER` and `NOELLE_REMOTE_REPO` for the build host. Configure `NOELLE_MAC_HOST` and the local actuator directory as needed before installing a timer. It copies builds; it does not provision the backend or account session.

## Verification

Verify the extension connects and reports the expected version and profile while publication is disabled. Check API health and the relevant worker state. Use a fixture or connection-boundary check for sender validation; do not send a real comment just to test connectivity.

When publication is intentionally enabled, inspect the platform receipt and the corresponding activity record. A pending or uncertain action is not a confirmed send.

## Monitoring boundary

The Chrome Bridge observability sink binds to the actuator host's loopback interface. A doctor process on the backend host may therefore see no local extension heartbeat while a remote actuator is healthy.

`NOELLE_DOCTOR_DRYRUN=1` suppresses the doctor's process, extension and database mutations while preserving observations. `NOELLE_DOCTOR_AUTOFIX=0` disables signature escalation only; it does not disable the deterministic remediation ladder. Configure monitoring for the actual sender host rather than using missing local heartbeats as proof that remote actuation failed.

See [Chrome Bridge](chrome-bridge.md), [the actuator guide](linkedin-actuator.md) and [the runtime runbook](runbook.md).

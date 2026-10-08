# Chrome Bridge and Actuator Doctor

Chrome Bridge controls the installation's Chrome browser through a local server and an extension. Actuator Doctor checks the social workers and browser actuators, applies bounded recovery steps, and records their results. Both are optional operational tools.

## Components and ownership

| Component | Responsibility |
| --- | --- |
| `apps/chrome-bridge` | Loopback HTTP control server, logs and heartbeats |
| `apps/chrome-bridge-ext` | Browser operations through a Chrome extension |
| `apps/chrome-bridge-mcp` | Stdio MCP tools that call the bridge HTTP API |
| `apps/actuator-doctor` | Probe, diagnose, recover, verify and record incidents |

The shared wire contracts live in `packages/contracts/src/chrome-bridge.ts` and `packages/contracts/src/actuator-doctor.ts`. Extend those owners when changing a cross-component operation.

The bridge binds to `127.0.0.1`, with port 18792 by default. Keep it on the local host. The extension's browser access can perform real actions; use a dedicated test account when checking writes.

## Authentication and browser control

Set `NOELLE_BRIDGE_TOKEN` in the installation's private environment. Caller routes require that bearer token. Without a configured token, those routes fail closed while the server can still report health. The extension transport and actuator ingest routes use the loopback boundary.

Chrome permits one debugger client per tab. Normal tab and DOM operations use `chrome.tabs` and `chrome.scripting`. Debugger operations are explicit and refuse actuator domains or an attached tab unless their force option is set. Avoid forced debugger attachment during an actuator run.

The extension polls the bridge over HTTP. Its content script wakes the service worker, receives an operation, executes it and reports the result. This avoids depending on a persistent extension service worker or WebSocket.

## HTTP routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Server health, without a bearer token |
| POST | `/op` | Execute a typed browser operation |
| GET | `/logs` | Query bounded actuator logs |
| GET | `/heartbeats` | Read the latest actuator heartbeat state |
| POST | `/ext/hello` | Register the extension |
| GET | `/ext/poll` | Receive queued operations |
| POST | `/ext/result` | Report an operation result |
| POST | `/ext/event` | Report browser events |
| GET | `/ext/build` | Read the current extension build stamp |
| POST | `/ingest/logs` | Store actuator log batches |
| POST | `/ingest/heartbeat` | Store an actuator heartbeat |

`POST /op` accepts `ChromeOp` and returns `ChromeOpResult`. An unavailable extension returns a failure, and operations have a configured timeout. Log queries accept source, time, level, text and limit filters.

Logs are capped and rotated. Defaults use `~/.noelle/logs/actuators`; `NOELLE_BRIDGE_LOG_DIR` can select another location. `NOELLE_BRIDGE_LOG_MAX_BYTES`, `NOELLE_BRIDGE_OP_TIMEOUT_MS` and `NOELLE_BRIDGE_STALE_MS` configure size, timeout and heartbeat freshness limits.

## MCP setup

Build the stdio server and its dependencies:

```sh
pnpm exec turbo run build --filter=@noelle/chrome-bridge-mcp
```

Configure your MCP client to run `node` with the absolute path to `apps/chrome-bridge-mcp/dist/index.js`. Supply `NOELLE_BRIDGE_URL` and `NOELLE_BRIDGE_TOKEN` through that client's private environment. The URL defaults to `http://127.0.0.1:18792`.

The public repository does not include a machine-specific MCP registration file. Each installation registers the server with its own client and credentials.

Tools cover tabs, navigation, DOM queries, clicks, typing, JavaScript, screenshots, console output, extension state, guarded debugger operations, logs, heartbeats and doctor status. Read the operation contract before using a tool that changes browser state.

## Recovery loop

The doctor checks process state, worker activity, due work, bridge connectivity and actuator heartbeats. Disabled lanes remain disabled. Browser connectivity faults can remain observe-only while no due browser work exists; an unavailable bridge or stuck activity keeps its own failure state.

Recovery steps are capped and ordered:

1. Reload the matching enabled extension.
2. Reconnect the bridge.
3. Restart the affected worker.
4. Apply the lane's kill switch.
5. Alert the configured operator.

Extension selection uses the shared manifest name and requires a receipt for the exact extension ID. Missing, disabled or ambiguous extensions produce a failure instead of choosing another target.

The next probe verifies recovery. State lives in `~/.noelle/doctor`, including the learned signature store and a capped incident log. Repeated alerts are deduplicated per incident. Configure the installation's alert command through `NOELLE_DOCTOR_ALERT_COMMAND`; no personal notification executable is required.

Automatic code repair is disabled by default. `NOELLE_DOCTOR_AUTOFIX` and `NOELLE_DOCTOR_DRYRUN` control repair and observation. Inspect the relevant contracts, configuration and incident record before enabling repair. An operational recovery record does not prove a social message was delivered.

## Operate

Use the managed CLI commands to inspect and start the configured components:

```sh
node apps/cli/dist/index.js bridge status
node apps/cli/dist/index.js doctor status
node apps/cli/dist/index.js bridge start
node apps/cli/dist/index.js doctor start
```

Load `apps/chrome-bridge-ext/dist-unpacked` through Chrome's extension developer mode after building it. Verify the bridge health, connected extension, build stamp and a read-only operation before testing account writes.

Follow [self hosting](self-host.md), [runtime operations](runbook.md) and [security](../SECURITY.md) for installation boundaries and managed updates.

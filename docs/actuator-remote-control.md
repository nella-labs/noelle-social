# Actuator remote start/stop (control the "hands" from your phone)

**Status: BUILT.** Lets you start and stop the browser actuators — Vega/X, Lyra/LinkedIn, Orion/Reddit — remotely, from the dashboard on your phone (`app.trynoelle.com`) or from chat (the `noelle_set_actuator_state` MCP tool), without being at the machine the extension runs on.

Before this, the actuator run lifecycle (Run / STOP / Full-automatic) lived only in `chrome.storage` and was driven by the in-page floating panel, so it could only be controlled from a browser at that machine. The one remote lever that existed — flipping `reply_send_enabled` to starve the queue — only stops *sending*; it can't start a run or stop the extension's autonomous browse/like lifecycle.

## The model: one source of truth + a reconciler

The "should the hands be running?" decision is now a durable, org-scoped **server value** on `noelle.agent_instances` that the phone, the MCP, and the local panel all write, and that each extension **reconciles to in near-real-time** over a long-poll.

```
   writes desired-state                              long-poll (~1s both ways)
 Phone / dashboard toggle ─────────────┐        ┌──────────────────────────────► reconcile:
 MCP noelle_set_actuator_state ────────┤        │  agent_instances.actuator_*     running → ensure the drain is live
 Local panel (Full-auto / STOP) ───────┘──► Cloud SQL ◄── api-vm GET /intent      stopped → end run + gate autonomy off
                                                    ▲  POST /intent-ack (runState) null    → local autonomy governs
                              extension acks its ACTUAL run state → dashboard shows reality
```

### The columns (migration `0089_actuator_remote_control.sql`)
On `noelle.agent_instances` (one actuator per intern instance, 1:1):

| column | meaning |
|---|---|
| `actuator_desired_state` | the operator's intent: `NULL` (no remote override — local autonomy governs, the backward-compatible default), `'running'`, or `'stopped'`. |
| `actuator_command_at` | bumped to `now()` on every change; the long-poll's change signal + the "stopped 2m ago" display. |
| `actuator_last_state` | the extension's report of its ACTUAL run state (`'running'` \| `'idle'`). |
| `actuator_seen_at` | when the extension last acked (liveness — "did my tap reach the hands?"). |

Nullable, no backfill: every existing instance starts at `NULL` = today's behavior, so deploying changed nothing until you first use the switch.

## What "start" and "stop" mean

- **Start (`running`) = the hands are ALLOWED to run** (persistent Full-automatic drain). It is **NOT** send-consent. On X, replies still only post when the separate **Sending** switch (`reply_send_enabled`) is on — so starting the actuator from your phone never silently begins posting. Start resumes the drain **behind the existing safety gates** (server health, post-challenge cooldown, overnight curfew).
- **Stop (`stopped`) = pause the hands entirely.** Ends any live run, clears the Full-auto standing intent, and hard-gates every autonomy path (daily auto-start, Full-auto resume, lights-out auto-drain) until you start again. Durable — it stays stopped across browser restarts and days, not just for today.

## The API (api-vm, actuator-bearer-token auth, org-scoped)

- `GET /api/actuator/intent?instanceId=&since=<commandAt-ms>&waitMs=25000` — **long-poll.** Returns `{ desired, commandAt }` immediately once `commandAt` advances past `since`; otherwise holds ≤25s and returns the current value at timeout. The extension re-reconciles on every return (self-heals run drift) and the in-flight fetch keeps the MV3 service worker alive. Polls the DB every ~1.5s because writes also arrive straight to Cloud SQL from the Vercel dashboard and the MCP.
- `POST /api/actuator/intent-ack` — `{ instanceId, runState, setDesired? }`. The extension reports its actual run state (liveness); `setDesired` is present ONLY on an explicit local panel action (Full-automatic / STOP) so the local panel and the remote switch never disagree.

Contracts: `ActuatorIntentResponseSchema`, `ActuatorIntentAckInSchema` in `@noelle/contracts` (`packages/contracts/src/actuator.ts`).

## The extension side

Each actuator (`apps/{x,linkedin,reddit}-actuator`) is an independent copy, so the same pattern is applied to all three:
- `src/lib/api.ts` — `fetchIntent(sinceMs)` (long-poll) + `ackIntent(runState, setDesired?)`.
- `src/background/index.ts` — an `intent loop` (long-poll → reconcile → re-poll; re-armed by `onStartup`/`onInstalled`/the 30s `actuator-tick` alarm so it survives service-worker death), a durable `REMOTE_STATE_KEY` mirror, a `remoteStopped()` gate at the top of `checkAutonomy()` (and `checkFullAuto()` on X/LinkedIn), and `publishLocalIntent()` wired into the panel's Full-automatic / STOP handlers.

Reconcile is **idempotent** (safe to re-run every poll / after any restart); the STOP *action* is **edge-triggered** (fires only on the transition into `stopped`) so a periodic re-apply never kills a one-shot manual Run the operator started afterward.

### Per-actuator differences
- **X (Vega)** — start does NOT arm sending (`reply_send_enabled` stays the operator's separate switch, because on X that column also arms the official-API send worker). Maps `running` onto the `startFullAuto` path.
- **LinkedIn (Lyra)** — the actuator arms its own sending on start (unchanged existing behavior), so `running` starts the hands AND sending via the Full-auto path.
- **Reddit (Orion)** — has no Full-automatic standing intent; `running` ensures a drain is live and the durable `REMOTE_STATE_KEY` itself provides persistence (the reconcile restarts a dead drain within ~25–30s). Orion auto-sends approved replies by design, so start = drain + auto-send.

## Using it

- **Phone / dashboard:** open the agent page (Vega / Lyra / Orion) → the **Hands: RUNNING/STOPPED** toggle next to Start/Pause and Sending. The sub-line shows the extension's actual state + liveness (`live · running`, `live · idle`, or `offline (seen …)`).
- **Chat / MCP:** `noelle_set_actuator_state` with `role` (or `agentInstanceId`) + `desired: running | stopped`.

## Precedence & safety notes

- The server `actuator_desired_state` is the single source of truth; the extension is authoritative-reconciled to it. Local panel Full-automatic / STOP publish back to it, so the two never fight.
- While `stopped`, the local kill switches remain authoritative and nothing auto-restarts (cleared Full-auto intent + stamped STOP + the autonomy gate).
- A `NULL` desired-state (never used the switch) leaves local autonomy exactly as before — zero behavior change.
- If the browser is closed the extension isn't polling; the dashboard shows `offline`, and the intent is applied when the browser reopens (`onStartup` re-arms the loop).

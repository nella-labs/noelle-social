import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { startSchedulerLoop } from "./lib/scheduler.js";

const env = loadEnv();
const app = createApp();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[api-vm] listening on :${info.port}`);
});

// Recurring scheduled-run loop (0085_run_schedule.sql). Fires armed per-instance
// schedules on their cadence. No-op unless NOELLE_RUN_SCHEDULER is on (default on);
// only ever acts on schedules an operator armed from the dashboard.
startSchedulerLoop();

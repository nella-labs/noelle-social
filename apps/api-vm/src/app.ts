import { Hono } from "hono";
import { logger } from "hono/logger";
import { requireUserJwt } from "./middleware/jwt.js";
import { requireHmac } from "./middleware/hmac.js";
import { requireRateLimit } from "./middleware/ratelimit.js";
import { outbound } from "./routes/outbound.js";
import { drafterCap, dashboardCap } from "./routes/cap-status.js";
import { drafts } from "./routes/drafts.js";
import { system } from "./routes/system.js";
import { busRead, busWrite } from "./routes/bus.js";
import { postIdeas } from "./routes/post-ideas.js";
import { postDrafts } from "./routes/post-drafts.js";
import { posts } from "./routes/posts.js";
import { contentMedia } from "./routes/content-media.js";
import { contentMediaRead, contentMediaWorkerRead } from "./routes/content-media-read.js";
import { contentSchedule } from "./routes/content-schedule.js";
import { xApi } from "./routes/x-api.js";
import { actuator } from "./routes/actuator.js";
import { linkedinDiscovery } from "./routes/linkedin-discovery-api.js";
import { xDiscovery } from "./routes/x-discovery-api.js";
import { actorReplyCap } from "./routes/actor-reply-cap.js";
import { patternAlerts } from "./routes/pattern-alerts.js";

// The Hono app is built in a factory so tests can construct it without
// invoking serve(). src/index.ts only starts the node server; everything
// else assembles via createApp().
//
// As of the noelle-vm-0 consolidation there's no openclaw-passthrough
// surface anymore — every route writes/reads `noelle.*` directly. The
// surviving routes are:
//   - POST /api/outbound            (HMAC) — VM agents push leads+drafts
//   - GET  /api/outbound/cap-status (HMAC) — VM agent pre-flight cap check
//   - POST /api/drafts/:id/send     (JWT)  — dashboard approves a draft
//   - POST /api/drafts/:id/skip     (JWT)  — dashboard skips a draft
//   - GET  /api/cap-status          (JWT)  — dashboard budget view

export function createApp() {
  const app = new Hono();

  app.use("*", logger());

  // CORS + Private Network Access. The LinkedIn Actuator browser extension
  // fetches this API cross-origin (chrome-extension:// → 127.0.0.1), which
  // triggers a preflight; Chrome additionally requires Access-Control-Allow-
  // Private-Network for requests to loopback. Handle OPTIONS before any auth
  // middleware (a preflight carries no bearer token) and reflect the headers.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin") ?? "*";
    const reqHeaders = c.req.header("access-control-request-headers") ?? "authorization,content-type";
    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": reqHeaders,
          "access-control-allow-private-network": "true",
          "access-control-max-age": "600",
          vary: "origin",
        },
      });
    }
    await next();
    c.header("access-control-allow-origin", origin);
    c.header("access-control-allow-private-network", "true");
    c.header("vary", "origin");
  });

  app.get("/health", (c) =>
    c.json({ ok: true, service: "noelle-api-vm", version: "0.0.1-alpha.0" })
  );

  // --- VM↔VM (HMAC) ---
  // Scope requireHmac to the outbound paths ONLY. A sub-app mounted at "/"
  // with `use("*")` leaks its middleware to every sibling route in Hono
  // (4.6.x) — that would 401 the JWT routes below with "missing_hmac_headers"
  // before they ever run. Matching the exact HMAC surface keeps VM↔VM auth on
  // /api/outbound* while leaving the user routes for the JWT group.
  const vm = new Hono();
  vm.use("/api/outbound", requireHmac);
  vm.use("/api/outbound/*", requireHmac);
  vm.use("/api/post-ideas", requireHmac);
  vm.use("/api/post-drafts", requireHmac);
  vm.route("/", outbound);
  vm.route("/", postIdeas);
  vm.route("/", postDrafts);
  vm.route("/", drafterCap);
  // busWrite applies requireHmac as per-route middleware on its POST handlers
  // (see routes/bus.ts) so it never shadows the JWT GET /api/bus/* reads.
  vm.route("/", busWrite);
  vm.route("/", contentMediaWorkerRead);

  app.route("/", vm);

  // --- User-facing (Supabase JWT + per-user rate limit) ---
  // Order matters: JWT must verify first so c.get('auth').userId is set
  // before requireRateLimit reads it. HMAC routes (above) are intentionally
  // NOT rate-limited here — they're VM↔VM, low-volume, and have their own
  // 5-minute timestamp window for replay protection.
  const user = new Hono();
  user.use("*", requireUserJwt);
  user.use("*", requireRateLimit);
  user.route("/", dashboardCap);
  user.route("/", drafts);
  user.route("/", posts);
  user.route("/", contentMedia);
  user.route("/", contentMediaRead);
  user.route("/", contentSchedule);
  user.route("/", xApi);
  user.route("/", system);
  user.route("/", busRead);
  user.route("/", patternAlerts);

  // --- Actuator (browser extension) — carries its own requireActuatorToken middleware ---
  // MUST be mounted BEFORE the `user` sub-app: `user.use("*", requireUserJwt)`
  // is a catch-all that would otherwise run first for the actuator paths and
  // reject the static actuator token with a JWT 401 (invalid_jwt).
  app.route("/", actuator);
  app.route("/", linkedinDiscovery);
  app.route("/", xDiscovery);
  app.route("/", actorReplyCap);

  app.route("/", user);

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error("[api-vm] unhandled", err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}

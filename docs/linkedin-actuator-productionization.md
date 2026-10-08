# LinkedIn Actuator — Productionization (Lima → `api.trynoelle.com`, multi-tenant)

**Audience:** whoever generalizes the LinkedIn Actuator from the single-operator Lima self-host to multi-tenant prod, so any user can run it against `api.trynoelle.com`.

**Read first:** [the actuator guide](linkedin-actuator.md) and [the runtime runbook](runbook.md).

**TL;DR of the delta.** The actuator was built so that prod parity is *config + auth*, not a rewrite. The endpoints already live in shared `apps/api-vm` (one server for Lima and prod). The single thing that is fundamentally Lima-only is **auth**: a static shared `NOELLE_ACTUATOR_TOKEN` mapped to one hardcoded org. Prod replaces that with the **per-user Supabase JWT** the dashboard already issues, plus a real org-membership check. Everything else — the scheduler, the trusted-CDP input layer, the content locators, supply-aware replenishment, ambient browsing — is identical.

---

## 1. What is Lima-specific today (the only things that must change)

| Concern | Lima (today) | Prod (target) |
|---|---|---|
| **Auth** | Static `NOELLE_ACTUATOR_TOKEN` (one shared secret) | Per-user Supabase JWT (`requireUserJwt`, already exists) |
| **Org scoping** | Static `NOELLE_ACTUATOR_ORG_ID` env (one org) | Derived from the JWT user + `org_members` membership check |
| **`decided_by` on mark-sent** | The configured `orgId` | The JWT user's `userId` (`auth.userId`) |
| **Extension credential** | Pasted static token in the options page | Acquired JWT (sign-in flow), auto-refreshed |
| **CORS** | None needed (background fetch + `host_permissions`) | Add `cors()` for any preflighted call (see §5) |
| **`host_permissions`** | broad `https://*/*` (dev convenience) | tighten to `https://api.trynoelle.com/*` |
| **Distribution** | Load-unpacked | Decide: enterprise / self-host / unlisted (the `debugger` permission gates the public Web Store — see §7) |

Everything not in this table is already prod-ready.

---

## 2. Current auth wiring (so you know exactly what you're replacing)

**Actuator routes** — `apps/api-vm/src/routes/actuator.ts`. Four routes, each guarded by its own `requireActuatorToken`:
- `GET  /api/actionable-linkedin?instanceId=…`
- `POST /api/linkedin-activity`
- `POST /api/drafts/:id/approve-dm`
- `POST /api/actuator/mark-sent/:id`

**Actuator middleware** — `apps/api-vm/src/middleware/actuator.ts`:
```ts
export type ActuatorContext = { orgId: string };
// requireActuatorToken: 503 if NOELLE_ACTUATOR_TOKEN/ORG_ID unset; 401 on missing/
// wrong bearer (timingSafeEqual); on success sets:
c.set("actuator", { orgId: env.NOELLE_ACTUATOR_ORG_ID });   // <-- static org, the Lima-ism
```

**The JWT path already exists** — `apps/api-vm/src/middleware/jwt.ts`:
```ts
export type AuthContext = { userId: string; email?: string; raw: JWTPayload };
// requireUserJwt: verifies Authorization: Bearer <jwt> via NOELLE_SUPABASE_JWKS_URL
// (preferred, key rotation) or NOELLE_SUPABASE_JWT_SECRET; 401 jwt_missing_sub if no sub;
c.set("auth", { userId: payload.sub, email: payload.email, raw: payload });
```

**Tenancy helpers already exist** — `apps/api-vm/src/lib/auth.ts` (wrapping `packages/runtime/src/tenancy.ts`):
```ts
isOrgMember(userId: string, orgId: string): Promise<boolean>
assertOrgMember(userId: string, orgId: string): Promise<void>   // throws OrgMembershipError
// backed by: select user_id from noelle.org_members where org_id=$1 and user_id=$2 limit 1
```

> ⚠️ **Mount-order gotcha (already bitten once — PR #239).** In `apps/api-vm/src/app.ts`, the `user` sub-app does `user.use("*", requireUserJwt)`. Any actuator routes mounted *after* it are shadowed by that catch-all and rejected with `invalid_jwt`. The actuator sub-app is therefore mounted **before** `user`. If you move actuator routes *into* the `user` sub-app for prod (so they get the JWT), this stops being a concern — but **add/keep a `createApp()`-level test** (`apps/api-vm/src/app.test.ts`) so route shadowing is caught in CI, not in prod. Per-route tests don't catch this.

---

## 3. The prod auth design (recommended)

Keep the same endpoints; change only how the org is established. Two equivalent shapes — pick one:

### Option A (recommended): make the actuator routes JWT-native
1. **Server:** add a small `resolveActuatorOrg` step that runs after `requireUserJwt`. For each actuator request, take the `instanceId` (or, for `approve-dm`/`mark-sent`, the draft/approval), look up the instance's `org_id`, then `assertOrgMember(auth.userId, org_id)`. Reuse the existing `agent_instances.org_id` column:
   ```ts
   // pseudo: in each actuator handler, replace the env-org check with:
   const inst = await sql`select org_id from noelle.agent_instances where id = ${instanceId} limit 1`;
   if (!inst[0]) return c.json({ error: "instance_not_found" }, 404);
   if (!(await isOrgMember(auth.userId, inst[0].org_id))) return c.json({ error: "not_org_member" }, 403);
   const orgId = inst[0].org_id;   // use this instead of c.get("actuator").orgId
   ```
   For `approve-dm`/`mark-sent`, resolve the org via the approval/draft → instance join (the queries already join `agent_instances ai`; swap `ai.org_id = ${envOrgId}` for a membership check on `auth.userId`).
2. **`decided_by`:** the actuator `mark-sent` path currently passes `decidedBy: orgId` to `markApprovalSent` (`apps/api-vm/src/routes/drafts.ts`). In prod, pass `decidedBy: auth.userId` — same as the JWT route — so the audit trail records the human, not the org.
3. **Mounting:** move the actuator routes under (or alongside) the JWT `user` sub-app, or add `requireUserJwt` to them. Keep `requireActuatorToken` available behind a feature flag so Lima self-host still works (see §4).

### Option B: keep `requireActuatorToken`, make it JWT-aware
Have `requireActuatorToken` accept *either* the static Lima token (when `NOELLE_ACTUATOR_TOKEN` is set — self-host) *or* a valid JWT (prod), and in the JWT case set `c.set("actuator", { orgId })` from the resolved instance + membership check. One middleware, two modes, switched by deployment env. Slightly more code in one place; avoids touching mount order.

**Recommendation:** Option A is cleaner long-term (reuses the dashboard's exact auth + tenancy primitives). Gate the Lima static-token path behind `NOELLE_AUTH_MODE` so both coexist.

---

## 4. Keep Lima working (don't break self-host)

Self-host (`NOELLE_AUTH_MODE=local`) has no Supabase JWT per request — it uses a single local operator. So **both auth paths must coexist**:
- If `NOELLE_ACTUATOR_TOKEN` is set → static-token mode (Lima), org = `NOELLE_ACTUATOR_ORG_ID`.
- Else → JWT mode (prod), org = resolved-from-instance + `isOrgMember(auth.userId, …)`.

Branch on `loadEnv()` / `NOELLE_AUTH_MODE` exactly as the rest of api-vm already does. Add tests for **both** modes at the `createApp()` level.

---

## 5. CORS (currently absent — add for prod)

`apps/api-vm` has **no** CORS middleware today (`app.ts` has none; no `Access-Control-*` anywhere). It works on Lima because the extension's **background service worker** fetches with `host_permissions` covering the API host, which is exempt from CORS in MV3.

For prod, add it defensively:
1. `import { cors } from "hono/cors"` and apply it to the actuator routes (and OPTIONS preflight) allowing the extension origin (`chrome-extension://<id>`) and the `Authorization` + `content-type` headers. Authorization-bearing requests are *not* "simple" → they preflight.
2. If you keep all API calls in the **background SW** (as today — `ActuatorApi` is only used in `src/background/index.ts`) and ship correct `host_permissions`, CORS is technically not required. But add `cors()` anyway so a future content-script-origin call, or a stricter browser, doesn't silently 0-status. Cheap insurance.

---

## 6. Extension changes (per-user credential)

Files: `apps/linkedin-actuator/src/lib/types.ts`, `src/lib/api.ts`, `src/options/*`.

- **`ActuatorConfig`** (`types.ts`) today: `{ apiBaseUrl, token, instanceId, caps, preferWatchlistRatio, deepNightTaper }`. The `token` field becomes a **JWT** (and likely an auto-managed one, not a pasted secret). `apiBaseUrl` → `https://api.trynoelle.com`. `instanceId` can be **auto-resolved** from the user's account instead of pasted (the user has exactly one `linkedin_intern` instance per org).
- **`ApiClient.headers()`** (`api.ts`) already sends `Authorization: Bearer ${config.token}` — works unchanged once `token` holds a JWT. `markSent` posts to `/api/actuator/mark-sent/:approvalId` (keep, or move under the JWT routes per §3).
- **Acquiring the JWT** — three options, easiest first:
  1. **Read the dashboard session.** Add a content script on `https://app.trynoelle.com/*` that reads the Supabase session JWT the dashboard already holds and stashes it in `chrome.storage` for the background SW. Zero new backend.
  2. **"Sign in with Noelle" OAuth** from the extension (a proper extension auth flow). Most robust; most work.
  3. **Manual paste** (interim): the user copies their JWT from the dashboard into the options page. Works today with no code change, but JWTs expire (bad UX). Use only as a stopgap.
- **JWT lifecycle:** JWTs expire (Supabase default ~1h). The extension must detect a `401 invalid_jwt`, refresh (re-read the session / re-run OAuth), and retry. Add this to `ApiClient.ok()`.
- **Auto-resolve `instanceId`:** add a `GET /api/me/linkedin-instance` (JWT-guarded) that returns the caller's `linkedin_intern` instance for their org, so the options page doesn't need a pasted UUID. Resolution query already exists in the dashboard — `apps/app/src/lib/queries.ts` `listOrgsForCurrentUser` + `listAgentInstancesForOrg` (filter `role = 'linkedin_intern'`).

---

## 7. Distribution — the real gating decision (`debugger` permission)

The extension declares `permissions: ["storage","alarms","debugger","tabs"]` (`wxt.config.ts`). The **`debugger` permission is the productionization blocker for a public Chrome Web Store listing** — Google treats it as high-privilege and reviews/rejects it aggressively, and Chrome shows the persistent *"…is debugging this browser"* banner during every run.

Because the *entire trusted-input mechanism* depends on `chrome.debugger` (CDP `Input.*`), you cannot drop it without losing the "real trusted input" property (the whole point vs. synthetic `.click()`). So pick a distribution model up front:
- **Self-host / load-unpacked** (today) — fine for power users; no review.
- **Enterprise / managed (force-install via policy)** — bypasses public review; good for a controlled rollout.
- **Unlisted Web Store item** — still reviewed, but not publicly discoverable.
- **Public Web Store** — expect a hard review on `debugger`; have a written justification ready, or reconsider the input mechanism.

Also tighten `host_permissions` from `https://*/*` to exactly `["https://www.linkedin.com/*", "https://api.trynoelle.com/*"]` before any submission, and pin the extension's ID (key in manifest) so the `chrome-extension://<id>` origin is stable for CORS allow-listing.

---

## 8. Multi-tenant safety (new concerns at scale)

- **Server-side caps.** Today caps are client-side (`ActuatorConfig.caps`) with a `noelle.linkedin_activity` log. For many users, enforce a **server-side daily backstop** keyed on `(org_id, day)` over `linkedin_activity`, so a tampered extension can't exceed limits. The table + index already exist (migration `0054`).
- **Abuse / anomaly monitoring** on `linkedin_activity` (per-org velocity, challenge-halt rate).
- **Per-user disable kill-switch** server-side (a flag the `GET /api/actionable-linkedin` checks) so you can stop a specific account's actuation centrally.
- **ToS reality, unchanged:** this auto-engages on LinkedIn. It's the safest form (own account, own session, manual, human-paced), but velocity is the dominant ban risk — keep the conservative defaults and `docs/x-account-safety.md` framing front-and-center for every operator.

---

## 9. Concrete checklist

- [ ] `app.ts`: decide Option A vs B; if A, mount actuator under/with the JWT `user` sub-app. Keep/extend `app.test.ts` mount-order regression.
- [ ] Actuator handlers: replace `c.get("actuator").orgId` (env org) with instance-derived org + `isOrgMember(auth.userId, org_id)`; gate the static-token path behind `NOELLE_AUTH_MODE`/`NOELLE_ACTUATOR_TOKEN`.
- [ ] `markApprovalSent` call in `routes/drafts.ts`/`actuator.ts`: `decidedBy: auth.userId` in JWT mode.
- [ ] Add `cors()` for the extension origin + Authorization preflight (§5).
- [ ] `GET /api/me/linkedin-instance` (JWT) for instance auto-resolution.
- [ ] Extension: JWT acquisition (read app.trynoelle.com session → `chrome.storage`) + 401-refresh-retry in `ApiClient.ok()`; options page drops the pasted token, auto-fills `instanceId`.
- [ ] `wxt.config.ts`: tighten `host_permissions`; pin the extension key/ID.
- [ ] Decide distribution model (§7) — this affects timeline more than any code.
- [ ] Server-side daily cap backstop on `linkedin_activity` (§8).
- [ ] Tests at `createApp()` level for BOTH auth modes; smoke against a real preview deploy (the per-route + pure tests will not catch auth-wiring/CORS regressions — they're only caught by an end-to-end hit, as the Lima deploy proved twice).

---

## 10. Hard-won lessons (from the Lima deploy)

Two bugs shipped green through 185 unit tests + multi-agent review and only surfaced on a live request — design your prod rollout to catch this class early with an **end-to-end smoke against a preview deploy**:
1. **Route shadowing** — actuator routes mounted after the JWT catch-all → `invalid_jwt` (PR #239).
2. **Wrong column** — queries used `agent_instances.organization_id`; the column is `org_id` (PR #240). Note `CLAUDE.md` says "organization_id everywhere" but `agent_instances` uses `org_id` — verify column names against the live schema, not the doc.
3. **Content-script dynamic import** — the panel never mounted because a `void import()` in the wxt content entrypoint fetched a non-web-accessible chunk (`chrome-extension://invalid`); use static imports in content entrypoints (PR #242).

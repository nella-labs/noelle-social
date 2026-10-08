import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NOTIFICATIONS_ACTOR_ENABLED } from "../src/lib/notifications-feature.js";
import { notificationSweepDue, SWEEP_MIN_GAP_MS } from "../src/background/notifications.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(join(here, "..", "src", p), "utf8");

// Notification actuation is disabled by a code gate. Configuration must not
// enable the lane without a deliberate source change.
describe("the notifications actor is disabled in code", () => {
  it("is off", () => {
    expect(NOTIFICATIONS_ACTOR_ENABLED).toBe(false);
  });

  it("no sweep can be due, whatever the caller asks for", () => {
    // Even with the lane flag on and the gap long past.
    expect(notificationSweepDue({ enabled: true, sinceLastSweepMs: 999_999_999, minGapMs: SWEEP_MIN_GAP_MS })).toBe(false);
    expect(notificationSweepDue({ enabled: true, sinceLastSweepMs: 0, minGapMs: 0 })).toBe(false);
  });

  it("the sweep gate is the FIRST thing checked — nothing can precede it", () => {
    // The sweep is what FILES conversation leads, so this is the real stop.
    const body = src("background/notifications.ts");
    const fn = body.slice(body.indexOf("export function notificationSweepDue"));
    const kill = fn.indexOf("NOTIFICATIONS_ACTOR_ENABLED");
    const laneFlag = fn.indexOf("args.enabled");
    expect(kill).toBeGreaterThan(-1);
    expect(kill).toBeLessThan(laneFlag);
  });

  it("startNotifications refuses even if invoked directly", () => {
    // The panel hiding the button is cosmetic; an old content script or a
    // console call must still be refused.
    const body = src("background/index.ts");
    const at = body.indexOf('msg.cmd === "startNotifications"');
    expect(at).toBeGreaterThan(-1);
    expect(body.slice(at, at + 420)).toContain("NOTIFICATIONS_ACTOR_ENABLED");
  });

// The `startNotifications` arm is the actual gate, so it gets executed rather
// than grepped.
//
// Grepping it does not work. Four rounds of review defeated every text-only
// assertion written here: a `/* */`-commented guard, a bypass condition wrapped
// around it, the flag import repointed at a module exporting true, a local
// shadow, and `startDrain` hoisted above the guard — each one read green while
// the actor started. That is not a run of bad regexes, it is the ceiling: a
// pattern over source can only prove that some lines sit near each other, never
// that the switch stops anything.
//
// The arm is fifteen lines and closes over nine names, all stubbable. So lift it
// out and run it, and let "did a drain start" be an observation.
const SENTINEL = { intent: "test.drainIntent", stopDay: "test.stopDay", remote: "test.remoteState" };

/** The arm's body, brace-matched out of the service worker. */
function liftArm(body: string): string {
  const at = body.indexOf('else if (msg.cmd === "startNotifications")');
  expect(at, "no startNotifications arm in background/index.ts").toBeGreaterThan(-1);
  const open = body.indexOf("{", at);
  let depth = 0;
  let i = open;
  for (; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}" && --depth === 0) break;
  }
  expect(depth, "unbalanced braces while lifting the arm").toBe(0);
  const inner = body.slice(open + 1, i);
  // If this ever lifts the wrong span, fail loudly instead of executing
  // something inert and reporting a comfortable zero.
  expect(inner, "lifted the wrong span: no flag").toContain("NOTIFICATIONS_ACTOR_ENABLED");
  expect(inner, "lifted the wrong span: no startDrain").toContain("startDrain(");
  return inner;
}

async function runArm(flag: boolean, msg: unknown = { cmd: "startNotifications" }) {
  const calls = { startDrain: 0, set: [] as string[], removed: [] as string[], replies: [] as unknown[] };
  const chrome = {
    storage: {
      local: {
        set: async (o: Record<string, unknown>) => void calls.set.push(...Object.keys(o)),
        remove: async (k: string) => void calls.removed.push(k),
      },
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (...a: unknown[]) => Promise<void>;
  // Every name the arm closes over is a parameter here. A call to anything else
  // — `sendResponse`, say, which is the bug this file was opened for — is a
  // ReferenceError that fails the test instead of being swallowed by the
  // listener's try/catch the way it was in production.
  const run = new AsyncFunction(
    "msg",
    "reply",
    "startDrain",
    "reserveStart",
    "prepareDrain",
    "requireStarted",
    "publishLocalIntent",
    "chrome",
    "NOTIFICATIONS_ACTOR_ENABLED",
    "DRAIN_INTENT_KEY",
    "DISCOVERY_MODE_KEY",
    "STOP_DAY_KEY",
    "REMOTE_STATE_KEY",
    liftArm(src("background/index.ts")),
  );
  await run(
    msg,
    (r: unknown) => void calls.replies.push(r),
    async () => { calls.startDrain++; return 1; },
    () => ({ epoch: Promise.resolve(1) }),
    async (_run: unknown, _intent: unknown) => { calls.set.push(SENTINEL.intent); },
    (epoch: number | null) => { if (epoch === null) throw new Error("start superseded"); return epoch; },
    () => {},
    chrome,
    flag,
    SENTINEL.intent,
    "actuator.browserDiscovery",
    SENTINEL.stopDay,
    SENTINEL.remote,
  );
  return calls;
}

describe("running the startNotifications arm with the actor disabled", () => {
  it("starts no drain and writes no standing intent", async () => {
    const c = await runArm(NOTIFICATIONS_ACTOR_ENABLED); // the real shipped value
    expect(NOTIFICATIONS_ACTOR_ENABLED).toBe(false);
    expect(c.startDrain, "the kill switch let a drain start").toBe(0);
    // DRAIN_INTENT_KEY is the durable standing intent checkDrainResume relaunches
    // on every service-worker wake. Persisting it while refusing would mean the
    // caller is told no and the actor comes back anyway, forever.
    expect(c.set, "the kill switch persisted a standing drain intent").toEqual([]);
    expect(c.replies).toHaveLength(1);
    expect(c.replies[0]).toMatchObject({ ok: false });
    expect(JSON.stringify(c.replies[0])).toContain("notifications-feature");
  });

  it("positive control: the same arm DOES start a drain when the flag is on", async () => {
    // Without this the assertion above is vacuous — a harness that executed
    // nothing would report the same zeros just as happily.
    const c = await runArm(true);
    expect(c.startDrain).toBe(1);
    expect(c.set).toContain(SENTINEL.intent);
    expect(c.replies[0]).toMatchObject({ ok: true });
  });

  it("the flag it reads is the one this suite proves is false", () => {
    // Injected above, so execution cannot see this: repointing the import at a
    // module exporting `true` leaves a textually perfect guard and a green suite.
    expect(src("background/index.ts")).toMatch(
      /import \{[^}]*NOTIFICATIONS_ACTOR_ENABLED[^}]*\} from "\.\.\/lib\/notifications-feature\.js"/,
    );
  });

  it("the guard is the first thing in the arm — nothing may precede it", () => {
    // Also invisible to execution: wrapping the guard in `if (msg.params?.force
    // !== true)` still refuses for the message this test sends. Same shape as the
    // sweep-gate assertion above, for the same reason.
    const body = src("background/index.ts");
    const at = body.indexOf('else if (msg.cmd === "startNotifications")');
    const kill = body.indexOf("if (!NOTIFICATIONS_ACTOR_ENABLED)", at);
    expect(kill, "the arm must guard on !NOTIFICATIONS_ACTOR_ENABLED").toBeGreaterThan(at);
    const before = body.slice(body.indexOf("{", at) + 1, kill).split("\n");
    // Everything between the opening brace and the guard must be blank or a
    // line comment. A `/* */` block or any statement is a finding.
    for (const line of before) {
      expect(line, `nothing may precede the kill switch: ${line.trim()}`).toMatch(/^\s*(\/\/.*)?$/);
    }
  });
});

  it("the panel does not render the button while it is off", () => {
    const body = src("content/panel.ts");
    expect(body).toContain("notificationsEnabled: NOTIFICATIONS_ACTOR_ENABLED");
    expect(body).toContain('if (NOTIFICATIONS_ACTOR_ENABLED) q("#na-notifs")');
  });

  it("re-enabling is a code edit — the flag reads from no env var or storage", () => {
    const flag = src("lib/notifications-feature.ts");
    expect(flag).not.toMatch(/process\.env|import\.meta\.env|chrome\.storage|localStorage/);
    expect(flag).toMatch(/export const NOTIFICATIONS_ACTOR_ENABLED = (true|false);/);
  });
});

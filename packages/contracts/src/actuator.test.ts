import { describe, it, expect } from "vitest";
import {
  ActionableLinkedInResponseSchema,
  ActuatorEnableSendInSchema,
  ActuatorEnableSendResultSchema,
  ActuatorIntentResponseSchema,
  ActuatorIntentAckInSchema,
  LinkedInActivityInSchema,
  actuatorApiHostPermissions,
} from "./actuator.js";

describe("actuator API host permissions", () => {
  it("keeps local hosts and adds only configured specific remote hosts", () => {
    expect(actuatorApiHostPermissions(" https://api.example.test:18791, http://10.0.0.5,https://api.example.test "))
      .toEqual(["http://localhost/*", "http://127.0.0.1/*", "https://api.trynoelle.com/*",
        "https://api.example.test/*", "http://10.0.0.5/*"]);
  });

  it("rejects broad permissions, credentials and path URLs", () => {
    for (const origin of ["https://*", "file:///tmp", "https://user:password@example.test",
      "https://api.example.test/private", "https://api.example.test/?token=test"]) {
      expect(() => actuatorApiHostPermissions(origin)).toThrow();
    }
  });
});

describe("actuator contracts", () => {
  it("parses a valid actionable-linkedin response", () => {
    const r = ActionableLinkedInResponseSchema.parse({
      comments: [
        {
          approval_id: "11111111-1111-1111-1111-111111111111",
          draft_id: "22222222-2222-2222-2222-222222222222",
          lead_id: "33333333-3333-3333-3333-333333333333",
          kind: "reply",
          body: "nice post",
          target: {
            type: "post",
            url: "https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000000/",
            activity_urn: "urn:li:activity:7300000000000000000",
            author_name: "Jane Doe",
          },
        },
      ],
      dms: [],
    });
    expect(r.comments[0]!.kind).toBe("reply");
  });

  it("rejects a comment item with type=profile target", () => {
    expect(() =>
      ActionableLinkedInResponseSchema.parse({
        comments: [
          {
            approval_id: "11111111-1111-1111-1111-111111111111",
            draft_id: "22222222-2222-2222-2222-222222222222",
            lead_id: "33333333-3333-3333-3333-333333333333",
            kind: "reply",
            body: "x",
            target: { type: "profile", url: "https://x", public_id: "p", recipient_name: "n" },
          },
        ],
        dms: [],
      }),
    ).toThrow();
  });

  it("parses a batched activity payload", () => {
    const a = LinkedInActivityInSchema.parse({
      session_id: "44444444-4444-4444-4444-444444444444",
      events: [
        { type: "like", activity_urn: "urn:li:activity:1", author_name: "A", at: "2026-06-20T00:00:00.000Z" },
        { type: "skip", reason: "selector-not-found", at: "2026-06-20T00:00:01.000Z" },
      ],
    });
    expect(a.events).toHaveLength(2);
  });

  it("accepts explicit null activity_urn / author_name (feed like with no URN)", () => {
    // Regression: the extension sends `null` (not omitted) for feed idle-likes /
    // ambient reads that have no resolvable post URN or scraped author. `.optional()`
    // rejected null → the WHOLE batch 500'd and nothing was inserted (dropping even
    // the comment rows in the same batch). `.nullish()` accepts it.
    const a = LinkedInActivityInSchema.parse({
      session_id: "44444444-4444-4444-4444-444444444444",
      events: [
        { type: "like", activity_urn: null, author_name: null, reaction: "LIKE", at: "2026-07-12T00:00:00.000Z" },
        { type: "comment", activity_urn: "urn:li:activity:9", at: "2026-07-12T00:00:01.000Z" },
      ],
    });
    expect(a.events).toHaveLength(2);
    expect(a.events[0]!.activity_urn).toBeNull();
    expect(a.events[0]!.author_name).toBeNull();
  });
});

describe("ActuatorEnableSendInSchema", () => {
  it("parses a valid enable/disable request", () => {
    const on = ActuatorEnableSendInSchema.parse({
      instanceId: "dd429dba-5bc5-4113-843a-974f854711a4",
      enabled: true,
    });
    expect(on.enabled).toBe(true);
    const off = ActuatorEnableSendInSchema.parse({
      instanceId: "dd429dba-5bc5-4113-843a-974f854711a4",
      enabled: false,
    });
    expect(off.enabled).toBe(false);
  });

  it("rejects a non-uuid instanceId or missing enabled", () => {
    expect(() => ActuatorEnableSendInSchema.parse({ instanceId: "not-a-uuid", enabled: true })).toThrow();
    expect(() => ActuatorEnableSendInSchema.parse({ instanceId: "dd429dba-5bc5-4113-843a-974f854711a4" })).toThrow();
  });
});

describe("ActuatorEnableSendResultSchema", () => {
  it("parses a result carrying the prior flag value (transition-aware arming)", () => {
    const r = ActuatorEnableSendResultSchema.parse({
      ok: true,
      instanceId: "dd429dba-5bc5-4113-843a-974f854711a4",
      reply_send_enabled: true,
      prior: false, // this write performed the OFF→ON transition
    });
    expect(r.prior).toBe(false);
  });

  it("accepts a result WITHOUT prior (older api-vm) — backward compatible; callers treat missing prior as prior=true", () => {
    const r = ActuatorEnableSendResultSchema.parse({
      ok: true,
      instanceId: "dd429dba-5bc5-4113-843a-974f854711a4",
      reply_send_enabled: true,
    });
    expect(r.prior).toBeUndefined();
  });

  it("rejects a non-boolean prior", () => {
    expect(() =>
      ActuatorEnableSendResultSchema.parse({
        ok: true,
        instanceId: "dd429dba-5bc5-4113-843a-974f854711a4",
        reply_send_enabled: true,
        prior: "yes",
      }),
    ).toThrow();
  });
});

describe("ActuatorIntentResponseSchema (remote start/stop, 0089)", () => {
  it("parses a standing 'running' intent with a commandAt", () => {
    const r = ActuatorIntentResponseSchema.parse({ desired: "running", commandAt: 1_700_000_000_000 });
    expect(r.desired).toBe("running");
    expect(r.commandAt).toBe(1_700_000_000_000);
  });

  it("parses a 'stopped' intent", () => {
    expect(ActuatorIntentResponseSchema.parse({ desired: "stopped", commandAt: 42 }).desired).toBe("stopped");
  });

  it("parses the never-commanded state (both null) — the backward-compatible default", () => {
    const r = ActuatorIntentResponseSchema.parse({ desired: null, commandAt: null });
    expect(r.desired).toBeNull();
    expect(r.commandAt).toBeNull();
  });

  it("rejects an unknown desired value and a negative/fractional commandAt", () => {
    expect(() => ActuatorIntentResponseSchema.parse({ desired: "paused", commandAt: 1 })).toThrow();
    expect(() => ActuatorIntentResponseSchema.parse({ desired: "running", commandAt: -1 })).toThrow();
    expect(() => ActuatorIntentResponseSchema.parse({ desired: "running", commandAt: 1.5 })).toThrow();
  });
});

describe("ActuatorIntentAckInSchema (extension → server)", () => {
  it("parses a routine ack (actual run state only, no intent publish)", () => {
    const r = ActuatorIntentAckInSchema.parse({
      instanceId: "dd429dba-5bc5-4113-843a-974f854711a4",
      runState: "running",
    });
    expect(r.runState).toBe("running");
    expect(r.setDesired).toBeUndefined();
  });

  it("parses a local-panel ack that also publishes the operator's new intent", () => {
    const r = ActuatorIntentAckInSchema.parse({
      instanceId: "dd429dba-5bc5-4113-843a-974f854711a4",
      runState: "idle",
      setDesired: "stopped",
    });
    expect(r.setDesired).toBe("stopped");
  });

  it("rejects a bad runState, a non-uuid instanceId, or an invalid setDesired", () => {
    expect(() =>
      ActuatorIntentAckInSchema.parse({ instanceId: "dd429dba-5bc5-4113-843a-974f854711a4", runState: "paused" }),
    ).toThrow();
    expect(() => ActuatorIntentAckInSchema.parse({ instanceId: "nope", runState: "idle" })).toThrow();
    expect(() =>
      ActuatorIntentAckInSchema.parse({
        instanceId: "dd429dba-5bc5-4113-843a-974f854711a4",
        runState: "idle",
        setDesired: "running-please",
      }),
    ).toThrow();
  });
});

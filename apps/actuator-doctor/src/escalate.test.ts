import { describe, expect, it } from "vitest";
import type { ProbeResult, SignatureStore } from "@noelle/contracts";
import { extractJsonObject, maybeEscalate, sanitizeLearnedSignature } from "./escalate.js";

const nowIso = "2026-07-18T00:00:00.000Z";

function probe(target: ProbeResult["target"], check: string): ProbeResult {
  return { target, check, ok: false, reason: "boom", metrics: {}, at: nowIso };
}

function emptyStore(): SignatureStore {
  return { version: 1, updatedAt: nowIso, signatures: [] };
}

describe("extractJsonObject", () => {
  it("pulls a balanced object out of surrounding prose/fences", () => {
    const out = 'here you go:\n```json\n{"id":"x","n":{"a":1}}\n```\nthanks';
    expect(extractJsonObject(out)).toEqual({ id: "x", n: { a: 1 } });
  });
  it("returns null when there is no object", () => {
    expect(extractJsonObject("INSUFFICIENT")).toBeNull();
  });
  it("handles braces inside strings", () => {
    expect(extractJsonObject('{"s":"a}b{c"}')).toEqual({ s: "a}b{c" });
  });
});

describe("sanitizeLearnedSignature", () => {
  const fresh = [probe("x-actuator", "heartbeat")];

  it("accepts a sound proposal and clamps it to a safe learned signature", () => {
    const sig = sanitizeLearnedSignature(
      {
        id: "X Heartbeat Gap!!",
        title: "t",
        description: "d",
        match: [{ target: "x-actuator", check: "heartbeat", ok: false }],
        ladder: ["reconnect_bridge"],
        maxPerHour: 99,
        confidence: 1,
      },
      fresh,
      emptyStore(),
      nowIso,
    );
    expect(sig).not.toBeNull();
    expect(sig!.origin).toBe("learned");
    expect(sig!.id).toBe("x-heartbeat-gap"); // kebab'd from "X Heartbeat Gap!!"
    expect(sig!.maxPerHour).toBeLessThanOrEqual(3); // clamped
    expect(sig!.confidence).toBeLessThanOrEqual(0.5); // clamped
    expect(sig!.ladder[sig!.ladder.length - 1]).toBe("page_human"); // always ends by paging
  });

  it("REJECTS a proposal that references a (target,check) outside the actual fault", () => {
    const sig = sanitizeLearnedSignature(
      {
        id: "evil",
        title: "t",
        description: "d",
        // linkedin-actuator/pm2 is NOT in `fresh` — a hallucinated match surface.
        match: [{ target: "linkedin-actuator", check: "pm2", ok: false }],
        ladder: ["engage_kill_switch"],
        maxPerHour: 1,
        confidence: 0.5,
      },
      fresh,
      emptyStore(),
      nowIso,
    );
    expect(sig).toBeNull();
  });

  it("drops unknown/unsafe ladder actions and still ends in page_human", () => {
    const sig = sanitizeLearnedSignature(
      {
        id: "s",
        title: "t",
        description: "d",
        match: [{ target: "x-actuator", check: "heartbeat", ok: false }],
        ladder: ["rm_rf_everything", "post_tweet", "reload_extension"],
        maxPerHour: 2,
        confidence: 0.4,
      },
      fresh,
      emptyStore(),
      nowIso,
    );
    expect(sig).not.toBeNull();
    expect(sig!.ladder).toEqual(["reload_extension", "page_human"]);
  });

  it("forces every match clause to assert ok:false", () => {
    const sig = sanitizeLearnedSignature(
      {
        id: "s",
        title: "t",
        description: "d",
        match: [{ target: "x-actuator", check: "heartbeat", ok: true }],
        ladder: ["page_human"],
        maxPerHour: 1,
        confidence: 0.2,
      },
      fresh,
      emptyStore(),
      nowIso,
    );
    expect(sig).not.toBeNull();
    expect(sig!.match[0]!.ok).toBe(false);
  });

  it("returns null for non-object / empty-match proposals", () => {
    expect(sanitizeLearnedSignature("nope", fresh, emptyStore(), nowIso)).toBeNull();
    expect(
      sanitizeLearnedSignature(
        { id: "s", title: "t", description: "d", match: [], ladder: ["page_human"], maxPerHour: 1, confidence: 0.2 },
        fresh,
        emptyStore(),
        nowIso,
      ),
    ).toBeNull();
  });

  it("suffixes the id to never clobber an existing signature", () => {
    const store = emptyStore();
    store.signatures.push({
      id: "x-heartbeat",
      title: "existing",
      description: "d",
      match: [{ target: "reddit-intern", check: "pm2", ok: false }],
      ladder: ["page_human"],
      maxPerHour: 1,
      timesSeen: 0,
      timesResolved: 0,
      lastSeen: null,
      origin: "seed",
      confidence: 0.5,
    });
    const sig = sanitizeLearnedSignature(
      {
        id: "x-heartbeat",
        title: "t",
        description: "d",
        match: [{ target: "x-actuator", check: "heartbeat", ok: false }],
        ladder: ["page_human"],
        maxPerHour: 1,
        confidence: 0.3,
      },
      fresh,
      store,
      nowIso,
    );
    expect(sig).not.toBeNull();
    expect(sig!.id).not.toBe("x-heartbeat"); // suffixed to stay unique
  });
});

describe("maybeEscalate gating", () => {
  const baseArgs = () => ({
    env: {
      NOELLE_DOCTOR_AUTOFIX: false,
      NOELLE_DOCTOR_DRYRUN: false,
      NOELLE_DOCTOR_ALERT_CATEGORY: "actuator-down",
    } as never,
    store: emptyStore(),
    logger: { warn() {}, error() {}, info() {} } as never,
    alert: async () => {},
    probes: [probe("x-actuator", "heartbeat")],
    matchedTargets: new Set<never>(),
    nowIso,
  });

  it("is a no-op when AUTOFIX is off (never spawns, never mutates the store)", async () => {
    const args = baseArgs();
    await maybeEscalate(args);
    expect(args.store.signatures).toHaveLength(0);
  });

  it("is a no-op when called with no args", async () => {
    await expect(maybeEscalate()).resolves.toBeUndefined();
  });

  it("does not escalate in DRYRUN even with AUTOFIX on", async () => {
    const args = baseArgs();
    (args.env as { NOELLE_DOCTOR_AUTOFIX: boolean }).NOELLE_DOCTOR_AUTOFIX = true;
    (args.env as { NOELLE_DOCTOR_DRYRUN: boolean }).NOELLE_DOCTOR_DRYRUN = true;
    await maybeEscalate(args);
    expect(args.store.signatures).toHaveLength(0);
  });
});

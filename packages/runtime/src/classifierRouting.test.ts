// Tests for the classifierRouting consolidated out of
// apps/{x,linkedin,reddit}-intern/src/lib/classifier-routing.ts.
//
// None of the three interns shipped a test for this file, so there was no
// existing coverage to carry over or union — these cases are new. They exist to
// pin WHICH BACKEND a classifier tick lands on, because this is the one function
// standing between "cheap Vertex Gemini triage" and "the engine default", and a
// silent routing flip here is a spend/behaviour incident, not a cosmetic bug.

import { describe, it, expect } from "vitest";
import { resolveClassifierModel } from "./classifierRouting.js";
import { WORKER_DEFAULTS } from "./workerRouting.js";

describe("resolveClassifierModel", () => {
  it("passes a vertex+gemini pick straight through, dashed handle intact", () => {
    expect(
      resolveClassifierModel({
        workers: { classifier: { primary: { engine: "vertex", model: "gemini-2-5-flash" } } },
      }),
    ).toEqual({ model: "gemini-2-5-flash", fellBack: false });

    expect(
      resolveClassifierModel({
        workers: { classifier: { primary: { engine: "vertex", model: "gemini-2-5-pro" } } },
      }),
    ).toEqual({ model: "gemini-2-5-pro", fellBack: false });
  });

  it("honours a legacy top-level primary when there is no per-worker override", () => {
    expect(
      resolveClassifierModel({ primary: { engine: "vertex", model: "gemini-2-5-flash" } }),
    ).toEqual({ model: "gemini-2-5-flash", fellBack: false });
  });

  it("a per-worker override beats the legacy primary", () => {
    expect(
      resolveClassifierModel({
        primary: { engine: "vertex", model: "gemini-2-5-flash" },
        workers: { classifier: { primary: { engine: "bedrock", model: "claude-haiku-4-5" } } },
      }),
    ).toEqual({ model: undefined, fellBack: true });
  });

  it("falls back (and flags it) for a bedrock Claude pick", () => {
    expect(
      resolveClassifierModel({
        workers: { classifier: { primary: { engine: "bedrock", model: "claude-sonnet-4-6" } } },
      }),
    ).toEqual({ model: undefined, fellBack: true });
  });

  it("falls back (and flags it) for an anthropic-direct pick", () => {
    expect(
      resolveClassifierModel({
        workers: { classifier: { primary: { engine: "anthropic", model: "claude-sonnet-4-6" } } },
      }),
    ).toEqual({ model: undefined, fellBack: true });
  });

  it("falls back for a preview vertex non-Gemini pick (collapsed to bedrock upstream)", () => {
    // vertex/claude-sonnet-4-6 is catalog status "preview", so effectiveHandle
    // swaps it to a bedrock handle before we ever see it — non-Gemini either way.
    expect(
      resolveClassifierModel({
        workers: { classifier: { primary: { engine: "vertex", model: "claude-sonnet-4-6" } } },
      }),
    ).toEqual({ model: undefined, fellBack: true });
  });

  it("with no overrides, reports the hardcoded classifier default as a fallback", () => {
    // WORKER_DEFAULTS.classifier is a bedrock handle, so the honest answer is
    // "not Gemini, tell the caller to log it".
    expect(WORKER_DEFAULTS.classifier?.primary.engine).toBe("bedrock");
    expect(resolveClassifierModel(null)).toEqual({ model: undefined, fellBack: true });
    expect(resolveClassifierModel(undefined)).toEqual({ model: undefined, fellBack: true });
    expect(resolveClassifierModel({})).toEqual({ model: undefined, fellBack: true });
  });

  it("never throws on a malformed model_overrides blob — it falls back", () => {
    // The callers hand this straight from the DB column as `unknown`.
    for (const junk of [
      "not-an-object",
      42,
      [],
      { workers: "nope" },
      { workers: { classifier: null } },
      { workers: { classifier: { primary: { engine: "vertex" } } } },
      { workers: { classifier: { primary: { engine: "made-up", model: "gemini-9" } } } },
      { primary: { engine: "vertex", model: "gemini-does-not-exist" } },
    ]) {
      expect(resolveClassifierModel(junk)).toEqual({ model: undefined, fellBack: true });
    }
  });

  it("an unrecognised handle does not masquerade as a Gemini pick", () => {
    // "gemini-9" is not in the catalog, so it must not slip through the
    // startsWith("gemini") branch and be handed to createVertexBackend.
    expect(
      resolveClassifierModel({
        workers: { classifier: { primary: { engine: "vertex", model: "gemini-9" } } },
      }),
    ).toEqual({ model: undefined, fellBack: true });
  });

  it("ignores overrides aimed at other workers", () => {
    expect(
      resolveClassifierModel({
        workers: { drafter: { primary: { engine: "vertex", model: "gemini-2-5-pro" } } },
      }),
    ).toEqual({ model: undefined, fellBack: true });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateJevBoolean, evaluateJevChoice, withJevFallbackBoolean } from "./jev.js";

afterEach(() => vi.unstubAllEnvs());

describe("Jev decisions", () => {
  it("uses true probability for both clear passes and clear failures", async () => {
    const pass = await evaluateJevBoolean({
      state: "A specific post", instructions: "Worth a reply?",
      run: async () => ({ answers: { answer: { type: "boolean", probability: 0.94 } } }),
    });
    const fail = await evaluateJevBoolean({
      state: "A generic post", instructions: "Worth a reply?",
      run: async () => ({ answers: { answer: { type: "boolean", probability: 0.12 } } }),
    });
    expect(pass).toEqual({ kind: "confident", pass: true, probability: 0.94, provider: "jev" });
    expect(fail).toEqual({ kind: "confident", pass: false, probability: 0.12, provider: "jev" });
  });

  it("uses the legacy judge only for an uncertain Jev answer", async () => {
    let calls = 0;
    const verdict = await withJevFallbackBoolean({
      state: "An ambiguous post", instructions: "Worth a reply?",
      run: async () => ({ answers: { answer: { type: "boolean", probability: 0.61 } } }),
      legacy: async () => { calls++; return true; },
    });
    expect(verdict).toEqual({ pass: true, provider: "legacy", judgeOk: true, probability: 0.61 });
    expect(calls).toBe(1);
  });

  it("reports unavailable on malformed responses or transport failure", async () => {
    const malformed = await evaluateJevBoolean({ state: "x", instructions: "valid?", run: async () => ({ answers: { answer: { type: "boolean", probability: 2 } } }) });
    const failed = await evaluateJevBoolean({ state: "x", instructions: "valid?", run: async () => { throw new Error("503"); } });
    expect(malformed.kind).toBe("unavailable");
    expect(failed.kind).toBe("unavailable");
  });

  it("validates the selected choice and its probability", async () => {
    const good = await evaluateJevChoice({
      state: "Practical engineering lesson", instructions: "Choose a category",
      criteria: { technical: "Engineering lesson", other: "Not relevant" },
      run: async () => ({ answers: { answer: { type: "choice", choice: "technical", probabilities: { technical: 0.88, other: 0.12 } } } }),
    });
    const bad = await evaluateJevChoice({
      state: "x", instructions: "Choose a category", criteria: { technical: "Engineering lesson", other: "Not relevant" },
      run: async () => ({ answers: { answer: { type: "choice", choice: "missing", probabilities: { missing: 1 } } } }),
    });
    expect(good).toEqual({ kind: "choice", choice: "technical", probability: 0.88, probabilities: { technical: 0.88, other: 0.12 }, provider: "jev" });
    expect(bad.kind).toBe("unavailable");
  });

  it("uses direct TypeSafe Jev first and maps a noul answer to the boolean decision", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-direct-key");
    const requests: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    let gatewayCalls = 0;
    const verdict = await evaluateJevBoolean({
      state: { post: "A concrete lesson" }, instructions: "Is this useful?",
      criteria: { true: "Specific lesson", false: "Generic statement" },
      directFetch: async (url, init) => {
        requests.push({ url, init });
        return Response.json({ answers: { answer: { type: "noul", noul: 0.93 } } });
      },
      run: async () => { gatewayCalls++; return { answers: { answer: { type: "boolean", probability: 0.2 } } }; },
    });
    expect(verdict).toEqual({ kind: "confident", pass: true, probability: 0.93, provider: "jev" });
    expect(gatewayCalls).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(requests[0]?.init?.headers).toMatchObject({ Authorization: "Bearer test-direct-key" });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      state: JSON.stringify({ post: "A concrete lesson" }), model: "jev-latest",
      questions: { answer: { type: "noul", instructions: "Is this useful?", criteria: { true: "Specific lesson", false: "Generic statement" } } },
    });
  });

  it("uses Gateway Jev when direct TypeSafe errors", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-direct-key");
    let gatewayCalls = 0;
    const verdict = await evaluateJevBoolean({
      state: "A specific post", instructions: "Worth a reply?",
      directFetch: async () => new Response("", { status: 503 }),
      run: async () => { gatewayCalls++; return { answers: { answer: { type: "boolean", probability: 0.86 } } }; },
    });
    expect(verdict).toEqual({ kind: "confident", pass: true, probability: 0.86, provider: "jev" });
    expect(gatewayCalls).toBe(1);
  });

  it("uses Gateway Jev when direct TypeSafe returns a malformed answer", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-direct-key");
    const verdict = await evaluateJevBoolean({
      state: "A specific post", instructions: "Worth a reply?",
      directFetch: async () => Response.json({ answers: { answer: { type: "noul", noul: 4 } } }),
      run: async () => ({ answers: { answer: { type: "boolean", probability: 0.9 } } }),
    });
    expect(verdict).toEqual({ kind: "confident", pass: true, probability: 0.9, provider: "jev" });
  });

  it("uses a direct TypeSafe choice distribution and stays unavailable when both Jev routes fail", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-direct-key");
    const direct = await evaluateJevChoice({
      state: "A practical post", instructions: "Choose a category",
      criteria: { technical: "Engineering lesson", other: "Not relevant" },
      directFetch: async () => Response.json({ answers: { answer: { type: "choice", choice: "technical", probabilities: { technical: 0.84, other: 0.16 }, confidence: 0.7 } } }),
      run: async () => { throw new Error("Gateway should not run"); },
    });
    const unavailable = await evaluateJevChoice({
      state: "A practical post", instructions: "Choose a category",
      criteria: { technical: "Engineering lesson", other: "Not relevant" },
      directFetch: async () => new Response("", { status: 503 }),
      run: async () => { throw new Error("Gateway unavailable"); },
    });
    expect(direct).toEqual({ kind: "choice", choice: "technical", probability: 0.84, probabilities: { technical: 0.84, other: 0.16 }, provider: "jev" });
    expect(unavailable).toEqual({ kind: "unavailable", provider: "jev" });
  });
});

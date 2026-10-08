import { describe, expect, it } from "vitest";
import { chatErrorMessage } from "./chat-error-message";

describe("chatErrorMessage", () => {
  it("never includes the literal phrase 'agent is offline'", () => {
    // The whole point of this helper: stop telling the founder the agent
    // is offline when the worker is fine and only the chat path is broken.
    const cases = [
      { status: 400, code: "invalid_body" },
      { status: 403, code: "forbidden" },
      { status: 404, code: "not_found" },
      { status: 500 },
      { status: 502, code: "model_error" },
      { status: 503, code: "model_unavailable" },
      {},
    ];
    for (const c of cases) {
      const msg = chatErrorMessage({ ...c, agentName: "Vega" }).toLowerCase();
      expect(msg).not.toContain("agent is offline");
    }
  });

  it("reassures that background work is unaffected on 5xx", () => {
    for (const status of [500, 502, 503]) {
      const msg = chatErrorMessage({ status, agentName: "Vega" });
      expect(msg.toLowerCase()).toContain("background work is unaffected");
    }
  });

  it("prefers the structured `code` over the status code", () => {
    // Server might return 500 with code=model_unavailable as a future expansion;
    // the helper should branch on the discriminator first.
    const msg = chatErrorMessage({
      status: 500,
      code: "model_unavailable",
      agentName: "Vega",
    });
    expect(msg).toContain("chat model isn't reachable");
  });

  it("uses the agentName for 5xx and 404 copy", () => {
    expect(
      chatErrorMessage({ status: 503, agentName: "Vega" }),
    ).toContain("Vega");
    expect(
      chatErrorMessage({ status: 404, agentName: "Vega" }),
    ).toContain("Vega");
  });

  it("403 / forbidden tells the user to sign in, not retry", () => {
    const msg = chatErrorMessage({ status: 403, agentName: "Vega" });
    expect(msg.toLowerCase()).toContain("sign in");
    expect(msg.toLowerCase()).not.toContain("try again");
  });

  it("400 / invalid_body suggests rephrasing", () => {
    const msg = chatErrorMessage({
      status: 400,
      code: "invalid_body",
      agentName: "Vega",
    });
    expect(msg.toLowerCase()).toContain("rephras");
  });

  it("falls back to generic copy when nothing is known", () => {
    const msg = chatErrorMessage({ agentName: "Vega" });
    expect(msg.toLowerCase()).toContain("couldn't reach chat");
  });
});

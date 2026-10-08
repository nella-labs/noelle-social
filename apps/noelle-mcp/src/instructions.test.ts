import { describe, expect, it } from "vitest";
import { SERVER_INSTRUCTIONS } from "./instructions.js";

describe("MCP approval contract", () => {
  it("treats pending X and LinkedIn replies as automatically reviewed and actor-ready", () => {
    expect(SERVER_INSTRUCTIONS).toContain(
      "A pending X or LinkedIn reply in Approvals already passed Noelle's automatic review and is ready for its actor",
    );
    expect(SERVER_INSTRUCTIONS).not.toContain(
      "requested replies stay in human review",
    );
    expect(SERVER_INSTRUCTIONS).not.toContain("Sending is a separate action.");
  });

  it("keeps original posts and Friendly DMs under human control", () => {
    expect(SERVER_INSTRUCTIONS).toContain(
      "Original posts and Friendly DMs still require human approval",
    );
  });
});

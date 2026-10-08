import { describe, it, expect } from "vitest";
import { extractProposal, extractVaultEdit } from "./proposal";

describe("extractProposal", () => {
  it("preserves normalized Reddit changes with and without a mission", () => {
    for (const mission of [undefined, "Meet founders"]) {
      const raw = "Review these communities.\n```noelle-proposal\n" + JSON.stringify({ mission, addSubreddits: ["r/SaaS", "saas"], removeSubreddits: ["r/Startups"] }) + "\n```";
      expect(extractProposal(raw).proposal).toMatchObject({ addSubreddits: ["saas"], removeSubreddits: ["startups"] });
    }
  });
  it("returns no proposal for an ordinary reply", () => {
    const out = extractProposal("Your top lead is @founder — high velocity.");
    expect(out.proposal).toBeNull();
    expect(out.text).toBe("Your top lead is @founder — high velocity.");
  });

  it("extracts and validates a well-formed proposal block", () => {
    const raw = [
      "Sure — I'll start watching for those.",
      "```noelle-proposal",
      '{"addKeywords":["Buffer","Hypefury"],"addHandles":["@levelsio"]}',
      "```",
    ].join("\n");
    const out = extractProposal(raw);
    expect(out.text).toBe("Sure — I'll start watching for those.");
    expect(out.proposal).not.toBeNull();
    expect(out.proposal?.addKeywords).toEqual(["Buffer", "Hypefury"]);
    // normalised by the contract (@ stripped, lowercased)
    expect(out.proposal?.addHandles).toEqual(["levelsio"]);
  });

  it("strips the block and supplies a fallback when there is no prose", () => {
    const raw = [
      "```noelle-proposal",
      '{"removeKeywords":["crypto"]}',
      "```",
    ].join("\n");
    const out = extractProposal(raw);
    expect(out.text).not.toContain("noelle-proposal");
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.proposal?.removeKeywords).toEqual(["crypto"]);
  });

  it("drops the proposal but strips the block when JSON is malformed", () => {
    const raw = [
      "Here you go.",
      "```noelle-proposal",
      "{ not valid json ]",
      "```",
    ].join("\n");
    const out = extractProposal(raw);
    expect(out.proposal).toBeNull();
    expect(out.text).toBe("Here you go.");
  });

  it("drops a no-op proposal (rejected by the contract)", () => {
    const raw = [
      "Nothing to change.",
      "```noelle-proposal",
      '{"addKeywords":[]}',
      "```",
    ].join("\n");
    const out = extractProposal(raw);
    expect(out.proposal).toBeNull();
    expect(out.text).toBe("Nothing to change.");
  });

  it("strips ALL proposal blocks even if the model wrongly emits more than one", () => {
    const raw = [
      "First change:",
      "```noelle-proposal",
      '{"addKeywords":["a"]}',
      "```",
      "and another:",
      "```noelle-proposal",
      '{"addKeywords":["b"]}',
      "```",
    ].join("\n");
    const out = extractProposal(raw);
    expect(out.text).not.toContain("noelle-proposal");
    expect(out.text).not.toContain("addKeywords");
    // We validate + return the first block only.
    expect(out.proposal?.addKeywords).toEqual(["a"]);
  });

  it("supports a mission-only proposal", () => {
    const raw = [
      "Updating your mission.",
      "```noelle-proposal",
      '{"mission":"find founders shipping AI agents"}',
      "```",
    ].join("\n");
    const out = extractProposal(raw);
    expect(out.proposal?.mission).toBe("find founders shipping AI agents");
  });
});

describe("extractVaultEdit", () => {
  it("returns no edit for an ordinary reply", () => {
    const out = extractVaultEdit("Your brand voice is dry and first-person.");
    expect(out.vaultEdit).toBeNull();
    expect(out.text).toBe("Your brand voice is dry and first-person.");
  });

  it("extracts + validates a well-formed vault-edit block", () => {
    const raw = [
      "I'll tighten your voice spec to ban hype.",
      "```noelle-vault-edit",
      '{"path":"voice-spec.md","content":"# Voice\\nNo hype. Lowercase. First person.","summary":"ban hype, enforce lowercase"}',
      "```",
    ].join("\n");
    const out = extractVaultEdit(raw);
    expect(out.text).toBe("I'll tighten your voice spec to ban hype.");
    expect(out.vaultEdit?.path).toBe("voice-spec.md");
    expect(out.vaultEdit?.content).toContain("No hype");
    expect(out.vaultEdit?.summary).toBe("ban hype, enforce lowercase");
  });

  it("strips the block + supplies a fallback when there is no prose", () => {
    const raw = ['```noelle-vault-edit', '{"path":"x.md","content":"hi","summary":"s"}', "```"].join("\n");
    const out = extractVaultEdit(raw);
    expect(out.vaultEdit?.path).toBe("x.md");
    expect(out.text).toMatch(/review and apply/i);
  });

  it("returns null edit for malformed JSON or a missing field", () => {
    expect(extractVaultEdit("```noelle-vault-edit\nnot json\n```").vaultEdit).toBeNull();
    expect(
      extractVaultEdit('```noelle-vault-edit\n{"path":"x.md"}\n```').vaultEdit,
    ).toBeNull();
  });
});

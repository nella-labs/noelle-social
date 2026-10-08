import { describe, it, expect } from "vitest";
import { shouldRecordContentEdit } from "./content-edits.js";

describe("shouldRecordContentEdit", () => {
  it("records when the operator changed the body", () => {
    expect(shouldRecordContentEdit("the drafter's post", "my edited post")).toBe(true);
  });

  it("does not record when there is no edit (null/undefined)", () => {
    expect(shouldRecordContentEdit("body", null)).toBe(false);
    expect(shouldRecordContentEdit("body", undefined)).toBe(false);
  });

  it("ignores pure whitespace-only differences", () => {
    expect(shouldRecordContentEdit("hello world", "  hello world  ")).toBe(false);
  });

  it("records a real change even with surrounding whitespace", () => {
    expect(shouldRecordContentEdit("hello world", "  hello WORLD  ")).toBe(true);
  });
});

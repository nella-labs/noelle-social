import { describe, it, expect } from "vitest";
import { reconcile, additiveOnly, type FileRef } from "./reconcile.js";

const ref = (relPath: string, md5: string): FileRef => ({ relPath, md5 });

describe("additiveOnly", () => {
  it("keeps uploads and drops every deletion", () => {
    expect(additiveOnly({ toUpload: ["a.md", "b.md"], toDelete: ["gone.md"] })).toEqual({
      toUpload: ["a.md", "b.md"],
      toDelete: [],
    });
  });

  it("is a no-op when there were no deletions", () => {
    expect(additiveOnly({ toUpload: ["a.md"], toDelete: [] })).toEqual({
      toUpload: ["a.md"],
      toDelete: [],
    });
  });
});

describe("reconcile", () => {
  it("uploads files absent remotely", () => {
    const plan = reconcile([ref("a.md", "1"), ref("b.md", "2")], [ref("a.md", "1")]);
    expect(plan).toEqual({ toUpload: ["b.md"], toDelete: [] });
  });

  it("uploads files whose md5 differs", () => {
    const plan = reconcile([ref("a.md", "NEW")], [ref("a.md", "OLD")]);
    expect(plan).toEqual({ toUpload: ["a.md"], toDelete: [] });
  });

  it("deletes remote files absent locally", () => {
    const plan = reconcile([ref("a.md", "1")], [ref("a.md", "1"), ref("gone.md", "9")]);
    expect(plan).toEqual({ toUpload: [], toDelete: ["gone.md"] });
  });

  it("no-ops when md5 matches", () => {
    const plan = reconcile([ref("a.md", "1")], [ref("a.md", "1")]);
    expect(plan).toEqual({ toUpload: [], toDelete: [] });
  });

  it("handles empty remote (first backfill)", () => {
    const plan = reconcile([ref("a.md", "1"), ref("b.md", "2")], []);
    expect(plan).toEqual({ toUpload: ["a.md", "b.md"], toDelete: [] });
  });

  it("returns deterministically sorted relPaths", () => {
    const plan = reconcile([ref("z.md", "1"), ref("a.md", "2")], []);
    expect(plan.toUpload).toEqual(["a.md", "z.md"]);
  });

  it("handles nested paths with interior slashes (filename validation is upstream)", () => {
    const plan = reconcile(
      [ref("01-business/company.md", "1"), ref("03-voice/tone.md", "2")],
      [ref("01-business/company.md", "1")],
    );
    expect(plan).toEqual({ toUpload: ["03-voice/tone.md"], toDelete: [] });
  });
});

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileLearnedPattern } from "./regex.js";
import { scoreFormat } from "../drafting/draftVerifier.js";

describe("bounded learned patterns", () => {
  it("matches phrases anywhere without case sensitivity or lost original snippets", () => {
    const pattern = compileLearnedPattern("big if true")!;
    expect(pattern.test("a specific take. BIG IF TRUE")).toBe(true);
    expect(pattern.match("a specific take. BIG IF TRUE")).toBe("BIG IF TRUE");
    expect(pattern.test("a different ending")).toBe(false);
    expect(pattern.match("a different ending")).toBeNull();
  });

  it("keeps explicit opener case and resets each match", () => {
    const pattern = compileLearnedPattern("^[a-z].*maintenance")!;
    for (let i = 0; i < 8; i++) {
      expect(pattern.test("my Maintenance note")).toBe(true);
      expect(pattern.test("My maintenance note")).toBe(false);
      expect(pattern.match("my Maintenance note")).toBe("my Maintenance");
    }
    expect(compileLearnedPattern("^[A-Z].*maintenance")!.test("My Maintenance note")).toBe(true);
  });

  it.each(["(word)\\1", "word(?=x)", "(?<=word)x", "(unclosed"])(
    "rejects unsupported syntax without native execution: %s", (source) => {
      expect(compileLearnedPattern(source)).toBeNull();
      const rules = [{ kind: "phrase" as const, label: "unsupported", instruction: "Vary the phrase", regex: source }];
      expect(scoreFormat({ kind: "reply", angle: null, body: "wordword wordx" }, undefined, false, false, rules).score)
        .toBe(1);
    });

  it.each(["a".repeat(513), "(?:a{1000}){1000}", "(?:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ){30}"])(
    "bounds source, expansion and compiled program size", (source) => {
      expect(compileLearnedPattern(source)).toBeNull();
    });

  it("does not misread escaped braces or a character class as repeat expansion", () => {
    expect(compileLearnedPattern("literal\\{1000000\\}")!.test("literal{1000000}")).toBe(true);
    expect(compileLearnedPattern("[{999999}]")!.test("{")).toBe(true);
  });

  it("reuses a bounded compiled cache and preserves behavior after eviction", () => {
    const first = compileLearnedPattern("bounded cache phrase")!;
    expect(compileLearnedPattern("bounded cache phrase")).toBe(first);
    for (let i = 0; i < 40; i++) compileLearnedPattern(`cache phrase ${i}`);
    const refreshed = compileLearnedPattern("bounded cache phrase")!;
    expect(refreshed).not.toBe(first);
    expect(refreshed.test("BOUNDED CACHE PHRASE")).toBe(true);
    expect(first.test("BOUNDED CACHE PHRASE")).toBe(true);
  });

  it("finishes a pathological failed match in an isolated process", () => {
    const owner = new URL("./regex.ts", import.meta.url).href;
    const script = `import {compileLearnedPattern} from ${JSON.stringify(owner)};
      const pattern = compileLearnedPattern('(a+)+$');
      if (!pattern || pattern.test('a'.repeat(30000)+'!')) process.exit(1);`;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      timeout: 2000, encoding: "utf8",
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  });
});

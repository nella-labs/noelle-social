import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrandConfigSchema, brandConfigHasContent } from "@noelle/contracts";
import { initBrandFile, loadBrandFile, scaffoldBrand, brandFilePath } from "./brand.js";
import type { Paths } from "../config.js";

let home: string;
function paths(): Paths {
  return {
    home,
    envFile: join(home, ".env"),
    configFile: join(home, "config.json"),
    ecosystem: join(home, "ecosystem.config.cjs"),
    pgdata: join(home, "pgdata"),
    logs: join(home, "logs"),
    heartbeats: join(home, "heartbeats"),
    cloudflared: join(home, "cloudflared"),
    doctor: join(home, "doctor"),
    stackDownMarker: join(home, "stack.down"),
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "noelle-home-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("brand file lifecycle", () => {
  it("scaffold is valid but carries no unverified brand facts", () => {
    const b = scaffoldBrand();
    expect(BrandConfigSchema.safeParse(b).success).toBe(true);
    expect(brandConfigHasContent(b)).toBe(false);
    expect(b.product?.surfaces).toEqual([]);
    expect(b.qa).toEqual([]);
  });

  it("init writes the questionnaire once and never clobbers edits", async () => {
    const first = initBrandFile(paths());
    expect(first.created).toBe(true);
    await writeFile(first.path, JSON.stringify({ persona: { name: "Edited" } }, null, 2));
    const second = initBrandFile(paths());
    expect(second.created).toBe(false);
    const onDisk = JSON.parse(await readFile(first.path, "utf8"));
    expect(onDisk.persona.name).toBe("Edited"); // not clobbered
  });

  it("loadBrandFile parses + validates", async () => {
    initBrandFile(paths());
    const b = loadBrandFile(paths());
    expect(b.pitch_policy).toBeDefined();
    expect(b.persona?.name).toBe("");
    expect(brandConfigHasContent(b)).toBe(false);
  });

  it("loadBrandFile throws a readable error on invalid shape", async () => {
    await writeFile(brandFilePath(paths()), JSON.stringify({ pitch_policy: "spam" }));
    expect(() => loadBrandFile(paths())).toThrow(/invalid/i);
  });

  it("loadBrandFile throws on malformed JSON", async () => {
    await writeFile(brandFilePath(paths()), "{ not json");
    expect(() => loadBrandFile(paths())).toThrow(/parse/i);
  });
});

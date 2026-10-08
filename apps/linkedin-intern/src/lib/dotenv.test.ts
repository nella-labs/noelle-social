import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOperatorEnvFile, loadOperatorEnvFile, operatorEnvFilePath } from "./dotenv.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noelle-dotenv-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeEnv(body: string): string {
  const p = join(dir, ".env");
  writeFileSync(p, body);
  return p;
}

describe("parseOperatorEnvFile (mirrors readEnvFile)", () => {
  it("reads bare values and skips comments/blanks/non-KEY lines", () => {
    const p = writeEnv("# header\n\nNOELLE_DATABASE_URL=postgres://u:p@localhost:5432/db\nlowercase=nope\nWORKER_ID=0\n");
    const env = parseOperatorEnvFile(p);
    expect(env.NOELLE_DATABASE_URL).toBe("postgres://u:p@localhost:5432/db");
    expect(env.WORKER_ID).toBe("0");
    expect(env.lowercase).toBeUndefined();
  });

  it("unwraps a quoted value (space / # that the writer would have quoted)", () => {
    // env-writer.quote() wraps a value containing whitespace or # in double quotes.
    const p = writeEnv('NOELLE_DATABASE_URL="postgres://noelle:p#a ss@host/db"\n');
    expect(parseOperatorEnvFile(p).NOELLE_DATABASE_URL).toBe("postgres://noelle:p#a ss@host/db");
  });

  it("unescapes \\\" and \\\\ inside a quoted value", () => {
    // writer emits \" for a literal quote and \\ for a literal backslash.
    const p = writeEnv('NOELLE_SECRET_X="a\\"b\\\\c"\n');
    expect(parseOperatorEnvFile(p).NOELLE_SECRET_X).toBe('a"b\\c');
  });

  it("treats an empty quoted value as the empty string", () => {
    const p = writeEnv('NOELLE_POSTS_CTA_PRODUCT=""\n');
    expect(parseOperatorEnvFile(p).NOELLE_POSTS_CTA_PRODUCT).toBe("");
  });

  it("does NOT shell-expand $ or backticks in a value", () => {
    const p = writeEnv('NOELLE_SECRET_LINKEDIN_LI_AT=AQEDlivevalue$HOME`whoami`end\n');
    expect(parseOperatorEnvFile(p).NOELLE_SECRET_LINKEDIN_LI_AT).toBe("AQEDlivevalue$HOME`whoami`end");
  });

  it("returns empty for a missing file", () => {
    expect(parseOperatorEnvFile(join(dir, "nope.env"))).toEqual({});
  });
});

describe("loadOperatorEnvFile", () => {
  it("applies keys not already set, without overriding existing ones", () => {
    const p = writeEnv("NOELLE_DATABASE_URL=postgres://from-file/db\nGCP_PROJECT=from-file\n");
    const env: NodeJS.ProcessEnv = { NOELLE_HOME: dir, GCP_PROJECT: "already-set" };
    const applied = loadOperatorEnvFile(env);
    expect(applied).toBe(1); // only NOELLE_DATABASE_URL applied
    expect(env.NOELLE_DATABASE_URL).toBe("postgres://from-file/db");
    expect(env.GCP_PROJECT).toBe("already-set"); // existing wins
  });

  it("honours NOELLE_HOME for the file location", () => {
    writeEnv("X=y\n");
    expect(operatorEnvFilePath({ NOELLE_HOME: dir })).toBe(join(dir, ".env"));
  });
});

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jwtVerify } from "jose";
import { defaultConfig } from "../config.js";
import { readEnvFile, writeEnvFile } from "./env-writer.js";
import { generateSecret, mintOperatorJwt } from "./identity.js";
import { SERVICES } from "./service-manifest.js";
import { reloadOperatorSession } from "./operator-session.js";

const run = vi.hoisted(() => vi.fn());
vi.mock("./platform.js", () => ({ run }));
vi.mock("./ui.js", () => ({ ui: { warn: vi.fn() } }));

describe("local operator session delivery", () => {
  let home: string;
  const config = defaultConfig();
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "noelle-session-test-"));
    run.mockReset().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const args = () => ({ envFile: join(home, ".env"), config, repoRoot: "/test/noelle", ecosystem: join(home, "ecosystem.cjs") });
  async function seed(expiresIn = "30d", signedBy?: string) {
    const secret = generateSecret();
    const jwt = await mintOperatorJwt({ secret: signedBy ?? secret, ...config.operator, expiresIn });
    writeEnvFile(args().envFile, { NOELLE_AUTH_MODE: "local", NOELLE_SUPABASE_JWT_SECRET: secret, NOELLE_LOCAL_OPERATOR_JWT: jwt });
    return { secret, jwt };
  }

  it("retries delivery after a failed restart even when the reminted token has thirty days left", async () => {
    await seed("1d");
    run.mockRejectedValueOnce(new Error("pm2 restart failed"));
    await expect(reloadOperatorSession(args())).rejects.toThrow("restart failed");
    const fresh = readEnvFile(args().envFile).NOELLE_LOCAL_OPERATOR_JWT;
    expect(await reloadOperatorSession(args())).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(readEnvFile(args().envFile).NOELLE_LOCAL_OPERATOR_JWT).toBe(fresh);
    expect(await reloadOperatorSession(args())).toBe(false);
  });

  it("delivers an already fresh token whose running-service receipt is missing", async () => {
    const { jwt } = await seed();
    expect(await reloadOperatorSession(args())).toBe(true);
    expect(readEnvFile(args().envFile).NOELLE_LOCAL_OPERATOR_JWT).toBe(jwt);
    expect(await reloadOperatorSession(args())).toBe(false);
  });

  it("remints a long-lived token signed with the previous secret and reloads both auth services", async () => {
    const { secret, jwt } = await seed("30d", generateSecret());
    await reloadOperatorSession(args());
    const token = readEnvFile(args().envFile).NOELLE_LOCAL_OPERATOR_JWT!;
    expect(token).not.toBe(jwt);
    await expect(jwtVerify(token, new TextEncoder().encode(secret))).resolves.toBeTruthy();
    expect(run.mock.calls[0]![1]).toContain(`${SERVICES.api},${SERVICES.app}`);
  });

  it("remints a token for the wrong operator even when its signature and expiry are valid", async () => {
    const { secret } = await seed();
    writeEnvFile(args().envFile, { ...readEnvFile(args().envFile), NOELLE_LOCAL_OPERATOR_JWT: await mintOperatorJwt({ secret, sub: "other", email: "other@example.com" }) });
    await reloadOperatorSession(args());
    const { payload } = await jwtVerify(readEnvFile(args().envFile).NOELLE_LOCAL_OPERATOR_JWT!, new TextEncoder().encode(secret));
    expect(payload.sub).toBe(config.operator.sub);
    expect(payload.email).toBe(config.operator.email);
  });


  it("never acknowledges a nonzero restart and stores only a private digest after success", async () => {
    const { jwt, secret } = await seed("1d");
    run.mockResolvedValueOnce({ code: 1, stdout: "", stderr: secret });
    await expect(reloadOperatorSession(args())).rejects.toThrow("Operator session restart failed");
    await expect(reloadOperatorSession(args())).resolves.toBe(true);
    const receipt = join(home, ".operator-session-applied");
    expect(readFileSync(receipt, "utf8")).toMatch(/^[a-f0-9]{64}\n$/);
    expect(readFileSync(receipt, "utf8")).not.toContain(jwt);
    expect(readFileSync(receipt, "utf8")).not.toContain(secret);
    expect(statSync(receipt).mode & 0o777).toBe(0o600);
  });

  it("aligns the dashboard identity and token with the configured operator", async () => {
    await seed();
    writeEnvFile(args().envFile, { ...readEnvFile(args().envFile), NOELLE_LOCAL_OPERATOR_SUB: "old", NOELLE_LOCAL_OPERATOR_EMAIL: "old@example.com" });
    await reloadOperatorSession(args());
    expect(readEnvFile(args().envFile).NOELLE_LOCAL_OPERATOR_SUB).toBe(config.operator.sub);
    expect(readEnvFile(args().envFile).NOELLE_LOCAL_OPERATOR_EMAIL).toBe(config.operator.email);
  });

  it("rejects a missing signing secret without replacing credentials or restarting", async () => {
    writeEnvFile(args().envFile, { NOELLE_AUTH_MODE: "local", UNRELATED: "preserved" });
    await expect(reloadOperatorSession(args())).rejects.toThrow("signing secret is missing");
    expect(readEnvFile(args().envFile)).toEqual({ NOELLE_AUTH_MODE: "local", UNRELATED: "preserved" });
    expect(run).not.toHaveBeenCalled();
  });

  it("has no session work in hosted auth mode", async () => {
    writeEnvFile(args().envFile, { NOELLE_AUTH_MODE: "supabase" });
    expect(await reloadOperatorSession(args())).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

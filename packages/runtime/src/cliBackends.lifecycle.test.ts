import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexCliBackend, CodexCliAuthError, CodexCliError, parseCodexUsage } from "./codexCliBackend.js";
import { createClaudeCliBackend, ClaudeCliAuthError, ClaudeCliError } from "./claudeCliBackend.js";

const call = { system: "instructions", prompt: "payload", model: "fixture" };
const ownedHomes: string[] = [];
function authHome() {
  const home = mkdtempSync(join(tmpdir(), "noelle-cli-fixture-"));
  ownedHomes.push(home);
  writeFileSync(join(home, "auth.json"), "{}");
  return home;
}
afterEach(() => {
  for (const home of ownedHomes.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.useRealTimers();
});

function resultSpawn(stdout: string, code = 0, stderr = "") {
  return (() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { write() {}, end() {} }), kill: vi.fn() });
    queueMicrotask(() => { child.stdout.emit("data", stdout); child.stderr.emit("data", stderr); child.emit("close", code); });
    return child;
  }) as unknown as typeof spawn;
}

describe("CLI completion admission", () => {
  it("reads the Codex model pin at call time after environment loading", async () => {
    let argv: string[] = [];
    const spawnImpl = ((cmd: string, args: string[], options: import("node:child_process").SpawnOptions) => {
      argv = args;
      const child = resultSpawn('{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}')(cmd, args, options);
      writeFileSync(args[args.indexOf("-o") + 1]!, "final message");
      return child;
    }) as typeof spawn;
    const backend = createCodexCliBackend({ codexHome: authHome(), spawnImpl });
    vi.stubEnv("NOELLE_CODEX_CLI_MODEL", "synthetic-model-pin");
    expect(await backend.call(call)).toMatchObject({ text: "final message" });
    expect(argv[argv.indexOf("-m") + 1]).toBe("synthetic-model-pin");
  });

  it("honors the documented Claude binary environment override without factory options", async () => {
    vi.stubEnv("NOELLE_CLAUDE_CLI_PATH", "synthetic-cli-path");
    const spawnImpl = vi.fn(resultSpawn('{"type":"result","result":"text"}'));
    await createClaudeCliBackend({ spawnImpl: spawnImpl as unknown as typeof spawn }).call(call);
    expect(spawnImpl.mock.calls[0]?.[0]).toBe("synthetic-cli-path");
  });

  it("honors the documented Claude timeout environment override", async () => {
    vi.stubEnv("NOELLE_CLAUDE_CLI_TIMEOUT_MS", "25");
    vi.useFakeTimers();
    const spawnImpl = (() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { end() {} }), kill: vi.fn() });
      child.kill.mockImplementation(() => { queueMicrotask(() => child.emit("close", null, "SIGKILL")); });
      return child;
    }) as unknown as typeof spawn;
    let error: unknown;
    const pending = createClaudeCliBackend({ spawnImpl }).call(call).catch(value => { error = value; });
    try {
      await vi.advanceTimersByTimeAsync(30);
      expect(error).toBeInstanceOf(ClaudeCliError);
    } finally { await vi.advanceTimersByTimeAsync(180_000); await pending; }
  });

  it("rejects missing Codex auth with the typed error and removes its temporary home", async () => {
    const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith("noelle-codex-")));
    const spawnImpl = vi.fn() as unknown as typeof spawn;
    const missing = join(authHome(), "missing");
    let created: string[] = [];
    try {
      const error = await createCodexCliBackend({ codexHome: missing, spawnImpl }).call(call).catch(error => error);
      created = readdirSync(tmpdir()).filter(name => name.startsWith("noelle-codex-") && !before.has(name));
      expect(error).toBeInstanceOf(CodexCliAuthError);
      expect(spawnImpl).not.toHaveBeenCalled();
      expect(created).toEqual([]);
    } finally {
      for (const name of readdirSync(tmpdir()).filter(name => name.startsWith("noelle-codex-") && !before.has(name))) {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      }
    }
  });

  it("types a synchronous Codex spawn failure and removes the copied-auth home", async () => {
    let temporaryHome = "";
    const spawnImpl = ((_cmd: string, _argv: string[], options: { env: NodeJS.ProcessEnv }) => {
      temporaryHome = options.env.CODEX_HOME!;
      throw new Error("synthetic spawn failure");
    }) as unknown as typeof spawn;
    try {
      const error = await createCodexCliBackend({ codexHome: authHome(), spawnImpl }).call(call).catch(error => error);
      expect(error).toBeInstanceOf(CodexCliError);
      expect(temporaryHome).not.toBe("");
      expect(existsSync(temporaryHome)).toBe(false);
    } finally { if (temporaryHome) rmSync(temporaryHome, { recursive: true, force: true }); }
  });

  it.each([{}, [], 3, { result: "" }, { result: "   " }, { result: 42 },
    { type: "progress", result: "not a completion" }, { is_error: "false", result: "wrong flag type" }])(
    "rejects a malformed Claude completion %j", async payload => {
      const backend = createClaudeCliBackend({ spawnImpl: resultSpawn(JSON.stringify(payload)) });
      await expect(backend.call(call)).rejects.toBeInstanceOf(ClaudeCliError);
    });

  it.each([1, 2])("rejects successful-looking Claude JSON when the child exits %i", async code => {
    const payload = { type: "result", is_error: false, result: "partial output", usage: { input_tokens: 5 } };
    await expect(createClaudeCliBackend({ spawnImpl: resultSpawn(JSON.stringify(payload), code) }).call(call))
      .rejects.toBeInstanceOf(ClaudeCliError);
  });

  it("types a synchronous Claude spawn failure", async () => {
    const spawnImpl = (() => { throw new Error("synthetic spawn failure"); }) as typeof spawn;
    await expect(createClaudeCliBackend({ spawnImpl }).call(call)).rejects.toBeInstanceOf(ClaudeCliError);
  });

  it.each([false, undefined])("preserves valid Claude text and auth words for flag %s", async is_error => {
    const payload = { type: "result", is_error, result: "OAuth login notes", usage: { input_tokens: 5, output_tokens: 2 } };
    expect(await createClaudeCliBackend({ spawnImpl: resultSpawn(JSON.stringify(payload)) }).call(call))
      .toMatchObject({ text: "OAuth login notes", usage: { input_tokens: 5, output_tokens: 2 } });
  });

  it.each([undefined, { input_tokens: -1, output_tokens: 2 },
    { input_tokens: 4, cache_creation_input_tokens: "5", output_tokens: 2 }])(
    "keeps malformed or missing Claude usage unreported: %j", async usage => {
      const payload = { type: "result", result: "usable text", usage, total_cost_usd: 0 };
      const result = await createClaudeCliBackend({ spawnImpl: resultSpawn(JSON.stringify(payload)) }).call(call);
      expect(result.usage).toMatchObject({ input_tokens: 0, token_usage_reported: false, cost_usd: 0 });
    });

  it.each(["", '{"type":"turn.completed","usage":{"input_tokens":"4","output_tokens":2}}']) (
    "keeps absent or malformed Codex usage unreported", stdout => {
      expect(parseCodexUsage(stdout)).toMatchObject({ input_tokens: 0, token_usage_reported: false });
    });

  it("does not invoke the legacy fallback for an unrelated unsupported option", async () => {
    const spawnImpl = vi.fn(resultSpawn("", 1, "error: unknown option '--model'")) as unknown as typeof spawn;
    await expect(createClaudeCliBackend({ spawnImpl }).call(call)).rejects.toBeInstanceOf(ClaudeCliError);
    expect(spawnImpl).toHaveBeenCalledOnce();
  });

  it("keeps the tools fallback within the original completion budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let attempts = 0;
    const spawnImpl = (() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { end() {} }), kill: vi.fn() });
      child.kill.mockImplementation(() => { queueMicrotask(() => child.emit("close", null, "SIGKILL")); });
      if (attempts++ === 0) setTimeout(() => {
        child.stderr.emit("data", "error: unknown option '--tools'"); child.emit("close", 1);
      }, 75);
      return child;
    }) as unknown as typeof spawn;
    try {
      let error: unknown;
      const pending = createClaudeCliBackend({ spawnImpl }).call({ ...call, timeoutMs: 100 }).catch(value => { error = value; });
      await vi.advanceTimersByTimeAsync(105);
      expect(error).toBeInstanceOf(ClaudeCliError); expect(attempts).toBe(2);
      await pending;
    } finally { vi.useRealTimers(); }
  });
});

describe("native CLI deadline ownership", () => {
  it.each(["codex", "claude"] as const)("preserves %s auth failure when its stdin pipe closes early", async kind => {
    const stdout = kind === "codex" ? JSON.stringify({ type: "turn.failed", error: { message: "Not logged in" } })
      : JSON.stringify({ type: "result", is_error: true, result: "Not logged in" });
    const script = `process.stdout.write(${JSON.stringify(stdout)});setTimeout(()=>process.exit(1),10);`;
    const spawnImpl = ((_cmd: string, _argv: string[], options: import("node:child_process").SpawnOptions) =>
      spawn(process.execPath, ["-e", script], options)) as typeof spawn;
    const backend = kind === "codex" ? createCodexCliBackend({ codexHome: authHome(), spawnImpl })
      : createClaudeCliBackend({ spawnImpl });
    await expect(backend.call({ ...call, prompt: "x".repeat(2 * 1024 * 1024), timeoutMs: 3000 }))
      .rejects.toBeInstanceOf(kind === "codex" ? CodexCliAuthError : ClaudeCliAuthError);
  });

  it.each(["codex", "claude"] as const)("%s rejects only after its timed-out child closes", async kind => {
    let child: ChildProcess | undefined;
    let home: string | undefined;
    let ready = false;
    const spawnImpl = ((_cmd: string, _argv: string[], options: import("node:child_process").SpawnOptions) => {
      home = options.env?.CODEX_HOME;
      child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);process.stdout.write("ready\\n");'], options);
      child.stdout?.on("data", data => { if (String(data).includes("ready")) ready = true; });
      return child;
    }) as typeof spawn;
    const backend = kind === "codex" ? createCodexCliBackend({ codexHome: authHome(), spawnImpl })
      : createClaudeCliBackend({ spawnImpl });
    try {
      const error = await backend.call({ ...call, timeoutMs: 1500 }).catch(error => error);
      expect(error).toBeInstanceOf(kind === "codex" ? CodexCliError : ClaudeCliError);
      expect(ready).toBe(true);
      expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
      if (home) expect(existsSync(home)).toBe(false);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {

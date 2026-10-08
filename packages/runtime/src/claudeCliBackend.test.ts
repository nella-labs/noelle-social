import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  createClaudeCliBackend,
  CLAUDE_CLI_MODEL,
  ClaudeCliError,
  ClaudeCliAuthError,
} from "./claudeCliBackend.js";

type SpawnCall = { cmd: string; args: string[]; options: Record<string, unknown> };

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { data: string; write(s: string): void; end(s?: string): void };
    kill: (sig?: string) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), {
    data: "",
    write(s: string) {
      this.data += s;
    },
    end(s?: string) { if (s) this.data += s; },
  });
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit("close", null, "SIGKILL")); });
  return child;
}

function fakeSpawn(plan: {
  stdout?: string;
  stderr?: string;
  code?: number;
  emitError?: Error;
  hang?: boolean;
}) {
  const calls: SpawnCall[] = [];
  const child = makeFakeChild();
  const spawnImpl = ((cmd: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ cmd, args, options });
    queueMicrotask(() => {
      if (plan.emitError) {
        child.emit("error", plan.emitError);
        child.emit("close", null, null);
        return;
      }
      if (plan.hang) return;
      if (plan.stdout) child.stdout.emit("data", Buffer.from(plan.stdout));
      if (plan.stderr) child.stderr.emit("data", Buffer.from(plan.stderr));
      child.emit("close", plan.code ?? 0);
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnImpl, calls, child };
}

const okJson = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "drafted reply text",
  usage: { input_tokens: 42, output_tokens: 17 },
  total_cost_usd: 0.01,
});

describe("createClaudeCliBackend", () => {
  it("parses result text and usage from claude -p json output", async () => {
    const { spawnImpl } = fakeSpawn({ stdout: okJson, code: 0 });
    const backend = createClaudeCliBackend({ spawnImpl });
    const res = await backend.call({
      system: "you are an intern",
      prompt: "draft a reply",
      model: "claude-sonnet-4-6",
    });
    expect(res.text).toBe("drafted reply text");
    expect(res.usage).toEqual({ input_tokens: 42, output_tokens: 17, cost_usd: 0.01 });
  });

  it("pipes prompt on stdin, never passes --bare", async () => {
    const { spawnImpl, calls, child } = fakeSpawn({ stdout: okJson });
    const backend = createClaudeCliBackend({ spawnImpl });
    await backend.call({ system: "sys", prompt: "the user prompt", model: "claude-opus-4-6" });
    const argv = calls[0]!.args;
    expect(argv).toContain("--print");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("json");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-5");
    expect(argv).toContain("--system-prompt");
    expect(argv).not.toContain("--bare");
    expect(child.stdin.data).toBe("the user prompt");
    expect(argv).not.toContain("the user prompt");
  });

  it("honours the per-call tier instead of forcing Opus on everything", async () => {
    // Forcing Opus made the classifier — 52% of calls, declared haiku in
    // modelCatalog — the most expensive thing Noelle ran. A flat-rate
    // subscription still spends a weekly allowance.
    const expected = {
      // The cheap tier is Opus 5 at low effort, not Haiku: benchmarked on 20
      // real leads, Haiku emitted 2,674 output tokens per call to Opus's 387
      // for the same JSON verdict, burning most of its per-token discount.
      "claude-haiku-4-5": "claude-opus-5",
      // sonnet-4-6 is the drafter's tier and is intentionally unmapped: it keeps
      // the strongest model until reply quality is actually compared.
      "claude-sonnet-4-6": CLAUDE_CLI_MODEL,
      "claude-opus-4-6": "claude-opus-5",
    } as const;
    for (const [requested, ran] of Object.entries(expected)) {
      const { spawnImpl, calls } = fakeSpawn({ stdout: okJson });
      const backend = createClaudeCliBackend({ spawnImpl });
      await backend.call({ system: "s", prompt: "p", model: requested });
      const argv = calls[0]!.args;
      expect(argv[argv.indexOf("--model") + 1]).toBe(ran);
    }
  });

  it("runs the cheap tier at low effort, and no other tier", async () => {
    const { spawnImpl, calls } = fakeSpawn({ stdout: okJson });
    const backend = createClaudeCliBackend({ spawnImpl });
    await backend.call({ system: "s", prompt: "p", model: "claude-haiku-4-5" });
    const argv = calls[0]!.args;
    expect(argv[argv.indexOf("--effort") + 1]).toBe("low");

    for (const tier of ["claude-sonnet-4-6", "claude-opus-4-6"] as const) {
      const f = fakeSpawn({ stdout: okJson });
      await createClaudeCliBackend({ spawnImpl: f.spawnImpl }).call({
        system: "s",
        prompt: "p",
        model: tier,
      });
      expect(f.calls[0]!.args).not.toContain("--effort");
    }
  });

  it("an operator model pin drops the effort flag", async () => {
    // Pinning is a regression workaround: give that model its own default
    // behaviour, not an effort level picked for a different one.
    const prev = process.env.NOELLE_CLAUDE_CLI_MODEL;
    process.env.NOELLE_CLAUDE_CLI_MODEL = "claude-sonnet-5";
    try {
      const { spawnImpl, calls } = fakeSpawn({ stdout: okJson });
      const backend = createClaudeCliBackend({ spawnImpl });
      await backend.call({ system: "s", prompt: "p", model: "claude-haiku-4-5" });
      const argv = calls[0]!.args;
      expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-5");
      expect(argv).not.toContain("--effort");
    } finally {
      if (prev === undefined) delete process.env.NOELLE_CLAUDE_CLI_MODEL;
      else process.env.NOELLE_CLAUDE_CLI_MODEL = prev;
    }
  });

  it("falls back to CLAUDE_CLI_MODEL for a handle that is not a tier key", async () => {
    // The chat route and Nova's text seam stamp CLAUDE_CLI_MODEL and pass that
    // same string as args.model. It must round-trip or the stamp starts lying.
    for (const requested of [CLAUDE_CLI_MODEL, "something-unknown"]) {
      const { spawnImpl, calls } = fakeSpawn({ stdout: okJson });
      const backend = createClaudeCliBackend({ spawnImpl });
      await backend.call({ system: "s", prompt: "p", model: requested });
      const argv = calls[0]!.args;
      expect(argv[argv.indexOf("--model") + 1]).toBe(CLAUDE_CLI_MODEL);
    }
  });

  it("records the CLI's own total_cost_usd so the ledger stops pricing calls at zero", async () => {
    // llmPrices lists claude-cli rows as quota-equivalent estimates for the cap
    // pre-flight; a COMPLETED call should carry the figure the CLI actually
    // reported instead.
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      usage: { input_tokens: 2, cache_creation_input_tokens: 1_175, output_tokens: 8 },
      total_cost_usd: 0.003612,
    });
    const { spawnImpl } = fakeSpawn({ stdout, code: 0 });
    const backend = createClaudeCliBackend({ spawnImpl });
    const res = await backend.call({ system: "s", prompt: "p", model: "claude-haiku-4-5" });
    expect(res.usage.cost_usd).toBe(0.003612);
  });

  it("omits cost_usd when the CLI does not report one", async () => {
    const { spawnImpl } = fakeSpawn({
      stdout: JSON.stringify({
        type: "result",
        is_error: false,
        result: "ok",
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
      code: 0,
    });
    const backend = createClaudeCliBackend({ spawnImpl });
    const res = await backend.call({ system: "s", prompt: "p", model: "claude-haiku-4-5" });
    expect(res.usage.cost_usd).toBeUndefined();
  });

  it("reads NOELLE_CLAUDE_CLI_MODEL at call time, not import time", async () => {
    // Workers call loadOperatorEnvFile() inside main(), AFTER @noelle/runtime is
    // evaluated. Resolving against the import-time constant would ignore the
    // operator's pin and silently send every call back to Opus.
    const prev = process.env.NOELLE_CLAUDE_CLI_MODEL;
    delete process.env.NOELLE_CLAUDE_CLI_MODEL; // unset at import, as on a real worker
    vi.resetModules();
    try {
      const fresh = await import("./claudeCliBackend.js");
      process.env.NOELLE_CLAUDE_CLI_MODEL = "claude-sonnet-5"; // arrives later
      const { spawnImpl, calls } = fakeSpawn({ stdout: okJson });
      const backend = fresh.createClaudeCliBackend({ spawnImpl });
      await backend.call({ system: "s", prompt: "p", model: "claude-haiku-4-5" });
      const argv = calls[0]!.args;
      expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    } finally {
      if (prev === undefined) delete process.env.NOELLE_CLAUDE_CLI_MODEL;
      else process.env.NOELLE_CLAUDE_CLI_MODEL = prev;
      vi.resetModules();
    }
  });

  it("counts cache-creation and cache-read tokens as input", async () => {
    // A cold `claude -p` spawn reports almost the entire prompt under
    // cache_creation_input_tokens; usage.input_tokens alone is the uncached
    // remainder (~2). Reading only that logged $0.00 for a ~29,000-token call.
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 12_681,
        cache_read_input_tokens: 14_619,
        output_tokens: 611,
      },
    });
    const { spawnImpl } = fakeSpawn({ stdout, code: 0 });
    const backend = createClaudeCliBackend({ spawnImpl });
    const res = await backend.call({ system: "s", prompt: "p", model: "claude-haiku-4-5" });
    expect(res.usage).toEqual({ input_tokens: 27_302, output_tokens: 611 });
  });

  it("falls back to the deny-list when the installed CLI does not know --tools", async () => {
    // Nothing pins the CLI version on the VM, and callAgentModel routes the
    // FALLBACK through this same engine for an llm_backend='claude' org — so an
    // unknown flag would take out every call with nothing behind it.
    const calls: string[][] = [];
    let attempt = 0;
    const spawnImpl = ((_cmd: string, argv: string[]) => {
      calls.push(argv);
      const child = makeFakeChild();
      const first = attempt++ === 0;
      queueMicrotask(() => {
        if (first) {
          child.stderr.emit("data", Buffer.from("error: unknown option '--tools'"));
          child.emit("close", 1);
        } else {
          child.stdout.emit("data", Buffer.from(okJson));
          child.emit("close", 0);
        }
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    const backend = createClaudeCliBackend({ spawnImpl });
    const res = await backend.call({ system: "s", prompt: "p", model: "claude-haiku-4-5" });

    expect(res.text).toBe("drafted reply text");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--tools");
    expect(calls[1]).not.toContain("--tools");
    expect(calls[1]![calls[1]!.indexOf("--disallowed-tools") + 1]).toContain("Bash");
  });

  it("does not retry when the failure is not an unknown flag", async () => {
    const { spawnImpl, calls } = fakeSpawn({ stderr: "boom", code: 1 });
    const backend = createClaudeCliBackend({ spawnImpl });
    await expect(
      backend.call({ system: "s", prompt: "p", model: "claude-haiku-4-5" }),
    ).rejects.toBeInstanceOf(ClaudeCliError);
    expect(calls).toHaveLength(1);
  });

  it("disables tools outright instead of deny-listing them", async () => {
    // `--disallowed-tools` denies execution but still uploads every tool schema
    // in the request body: 17,931 input tokens vs 1,609 with `--tools ""` on an
    // identical one-shot call. These runs never need a tool, so ship none.
    const { spawnImpl, calls } = fakeSpawn({ stdout: okJson });
    const backend = createClaudeCliBackend({ spawnImpl });
    await backend.call({ system: "s", prompt: "p", model: "claude-haiku-4-5" });
    const argv = calls[0]!.args;
    expect(argv).not.toContain("--disallowed-tools");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).toContain("--disable-slash-commands");
    expect(argv).toContain("--strict-mcp-config");
  });

  it("exports CLAUDE_CLI_MODEL as the exact string passed to --model", async () => {
    // The dashboard chat route and Nova's text seam import this constant to
    // label/stamp the call. Asserting it against the real argv is what keeps
    // the recorded model honest — three hand-copied literals had drifted.
    const { spawnImpl, calls } = fakeSpawn({ stdout: okJson });
    const backend = createClaudeCliBackend({ spawnImpl });
    await backend.call({ system: "s", prompt: "p", model: CLAUDE_CLI_MODEL });
    const argv = calls[0]!.args;
    expect(argv[argv.indexOf("--model") + 1]).toBe(CLAUDE_CLI_MODEL);
  });

  it("NOELLE_CLAUDE_CLI_MODEL overrides the default model", async () => {
    const prev = process.env.NOELLE_CLAUDE_CLI_MODEL;
    process.env.NOELLE_CLAUDE_CLI_MODEL = "claude-sonnet-4-6";
    // CLAUDE_CLI_MODEL is read at module load, so re-import the module fresh
    // after setting the env so the override is picked up.
    vi.resetModules();
    try {
      const fresh = await import("./claudeCliBackend.js");
      const { spawnImpl, calls } = fakeSpawn({ stdout: okJson });
      const backend = fresh.createClaudeCliBackend({ spawnImpl });
      await backend.call({ system: "s", prompt: "p", model: "claude-opus-4-6" });
      const argv = calls[0]!.args;
      expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
    } finally {
      if (prev === undefined) delete process.env.NOELLE_CLAUDE_CLI_MODEL;
      else process.env.NOELLE_CLAUDE_CLI_MODEL = prev;
      vi.resetModules();
    }
  });

  it("strips API-key / 3P-provider env so the child can only use the OAuth subscription", async () => {
    const sanitized = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const k of sanitized) {
      saved[k] = process.env[k];
      process.env[k] = "should-be-stripped";
    }
    // A benign var that must survive untouched.
    const prevPath = process.env.PATH;
    try {
      const { spawnImpl, calls } = fakeSpawn({ stdout: okJson });
      const backend = createClaudeCliBackend({ spawnImpl });
      await backend.call({ system: "s", prompt: "p", model: "claude-opus-4-6" });
      const env = calls[0]!.options.env as Record<string, string | undefined>;
      expect(env).toBeDefined();
      for (const k of sanitized) {
        expect(env[k]).toBeUndefined();
      }
      // Non-sanitized env passes through.
      expect(env.PATH).toBe(prevPath);
    } finally {
      for (const k of sanitized) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it("throws ClaudeCliError on non-zero exit", async () => {
    const { spawnImpl } = fakeSpawn({ stdout: "", stderr: "boom", code: 1 });
    const backend = createClaudeCliBackend({ spawnImpl });
    await expect(
      backend.call({ system: "s", prompt: "p", model: "claude-sonnet-4-6" }),
    ).rejects.toBeInstanceOf(ClaudeCliError);
  });

  it("throws ClaudeCliError when result json has is_error:true", async () => {
    const errJson = JSON.stringify({ type: "result", is_error: true, result: "model failure" });
    const { spawnImpl } = fakeSpawn({ stdout: errJson, code: 0 });
    const backend = createClaudeCliBackend({ spawnImpl });
    await expect(
      backend.call({ system: "s", prompt: "p", model: "claude-sonnet-4-6" }),
    ).rejects.toBeInstanceOf(ClaudeCliError);
  });

  it("throws ClaudeCliAuthError when stderr signals an auth/login problem", async () => {
    const { spawnImpl } = fakeSpawn({
      stdout: "",
      stderr: "Invalid API key - please log in",
      code: 1,
    });
    const backend = createClaudeCliBackend({ spawnImpl });
    const err = await backend
      .call({ system: "s", prompt: "p", model: "claude-sonnet-4-6" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeCliAuthError);
    expect(err).toBeInstanceOf(ClaudeCliError);
  });

  it("throws ClaudeCliAuthError when a code-0 is_error result detail signals auth", async () => {
    const errJson = JSON.stringify({
      type: "result",
      is_error: true,
      result: "Invalid API key - please log in",
    });
    const { spawnImpl } = fakeSpawn({ stdout: errJson, code: 0 });
    const backend = createClaudeCliBackend({ spawnImpl });
    const err = await backend
      .call({ system: "s", prompt: "p", model: "claude-sonnet-4-6" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeCliAuthError);
    expect(err).toBeInstanceOf(ClaudeCliError);
  });

  it("resolves a successful draft whose result text mentions oauth/login (no false auth error)", async () => {
    const draft =
      "Honestly the OAuth flow is the real win here \u2014 just hit the button and please log in once, that is it.";
    const successJson = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: draft,
      usage: { input_tokens: 100, output_tokens: 30 },
    });
    const { spawnImpl } = fakeSpawn({ stdout: successJson, code: 0 });
    const backend = createClaudeCliBackend({ spawnImpl });
    const res = await backend.call({
      system: "you are an intern",
      prompt: "draft a reply about oauth login",
      model: "claude-sonnet-4-6",
    });
    expect(res.text).toBe(draft);
    expect(res.usage).toEqual({ input_tokens: 100, output_tokens: 30 });
  });

  it("non-zero exit with raw (non-JSON) auth text in STDOUT (clean stderr) throws plain ClaudeCliError, not auth", async () => {
    // Unstructured stdout text must NEVER drive auth classification — only a
    // structured is_error:true JSON detail (or stderr) may.
    const { spawnImpl } = fakeSpawn({
      stdout: "unauthorized: garbage non-json",
      stderr: "",
      code: 1,
    });
    const backend = createClaudeCliBackend({ spawnImpl });
    const err = await backend
      .call({ system: "s", prompt: "p", model: "claude-sonnet-4-6" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeCliError);
    expect(err).not.toBeInstanceOf(ClaudeCliAuthError);
  });

  it("real not-logged-in payload (is_error:true JSON on stdout, empty stderr, exit 1) throws ClaudeCliAuthError", async () => {
    // EXACT real-world response captured from `claude -p` on the live VM.
    const notLoggedIn = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const { spawnImpl } = fakeSpawn({ stdout: notLoggedIn, stderr: "", code: 1 });
    const backend = createClaudeCliBackend({ spawnImpl });
    const err = await backend
      .call({ system: "s", prompt: "p", model: "claude-sonnet-4-6" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeCliAuthError);
    expect(err).toBeInstanceOf(ClaudeCliError);
    expect((err as Error).message).toContain("Not logged in");
  });

  it("throws ClaudeCliError on unparseable stdout", async () => {
    const { spawnImpl } = fakeSpawn({ stdout: "not json at all", code: 0 });
    const backend = createClaudeCliBackend({ spawnImpl });
    await expect(
      backend.call({ system: "s", prompt: "p", model: "claude-sonnet-4-6" }),
    ).rejects.toBeInstanceOf(ClaudeCliError);
  });

  it("throws ClaudeCliError on spawn error (binary missing)", async () => {
    const { spawnImpl } = fakeSpawn({ emitError: new Error("ENOENT claude") });
    const backend = createClaudeCliBackend({ spawnImpl });
    await expect(
      backend.call({ system: "s", prompt: "p", model: "claude-sonnet-4-6" }),
    ).rejects.toBeInstanceOf(ClaudeCliError);
  });

  it("a per-call timeoutMs overrides the backend default", async () => {
    // One global timeout cannot serve a ~9s drafter reply and a ~160s
    // pattern-breaker run. The pattern-breaker blew the 180s default 54 times
    // out of 66, paying for the generation each time and keeping none of it.
    const { spawnImpl, child } = fakeSpawn({ hang: true });
    const backend = createClaudeCliBackend({ spawnImpl, timeoutMs: 5_000 });
    const err = await backend
      .call({ system: "s", prompt: "p", model: "claude-sonnet-4-6", timeoutMs: 20 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeCliError);
    expect((err as Error).message).toMatch(/timed out after 20ms/i);
    expect(child.kill).toHaveBeenCalled();
  });

  it("times out a hung process and kills it", async () => {
    const { spawnImpl, child } = fakeSpawn({ hang: true });
    const backend = createClaudeCliBackend({ spawnImpl, timeoutMs: 20 });
    const err = await backend
      .call({ system: "s", prompt: "p", model: "claude-sonnet-4-6" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeCliError);
    expect((err as Error).message).toMatch(/timed out/i);
    expect(child.kill).toHaveBeenCalled();
  });

  it("default timeout is 180000ms (does not fire on a sub-second hang)", async () => {
    vi.useFakeTimers();
    try {
      const { spawnImpl } = fakeSpawn({ hang: true });
      const backend = createClaudeCliBackend({ spawnImpl }); // no timeoutMs override
      let settled = false;
      const promise = backend
        .call({ system: "s", prompt: "p", model: "claude-opus-4-6" })
        .then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
      // Advance well past the OLD 120s default but short of the new 180s one.
      await vi.advanceTimersByTimeAsync(150_000);
      expect(settled).toBe(false);
      // Now cross the 180s default → it times out.
      await vi.advanceTimersByTimeAsync(31_000);
      await promise;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

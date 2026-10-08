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

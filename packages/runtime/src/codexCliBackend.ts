import { spawn as nodeSpawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineBackend, TokenUsage } from "./callAgentModel.js";
import { CliProcessError, cliTimeoutMs, readCliAnswer, runCliProcess } from "./cliProcess.js";
import { isAccountingInteger, normalizeTokenUsage } from "./callCostAccounting.js";

/**
 * Local Codex CLI (`codex exec`) EngineBackend — the OpenAI-side twin of
 * claudeCliBackend. It routes through whatever the installed `codex` is
 * authenticated against; on this VM that is a ChatGPT subscription (OAuth), so
 * the marginal cost is a different pot rather than a different invoice.
 *
 * That is the whole point. The Claude weekly allowance is the binding
 * constraint, and when it is spent the agents stop. Falling through to a
 * subscription that is otherwise idle keeps work moving instead.
 *
 * Single-shot semantics, mirroring the Claude backend:
 *   - `exec` is the non-interactive mode; the prompt arrives on stdin.
 *   - `--sandbox read-only` so a model-generated command can never write.
 *   - `--skip-git-repo-check` because we run from a temp dir, not a repo.
 *   - `--ephemeral` so no session file is persisted per call.
 *   - `-o <file>` is the ONLY reliable way to read the final answer: the JSONL
 *     stream carries events, not a single result object.
 *
 * Codex has no `--system-prompt`, and no equivalent of Claude's `--tools ""`:
 * it is an agentic coding harness and always ships its tool definitions. The
 * best available reduction is an isolated CODEX_HOME — the operator's real home
 * carries 176 skills and an AGENTS.md, and dropping those measured 19,131 input
 * tokens down to ~8-12k. Batched callers amortise what remains.
 */

export class CodexCliError extends Error {
  readonly stderr: string | undefined;
  constructor(message: string, stderr?: string) {
    super(message);
    this.name = "CodexCliError";
    this.stderr = stderr;
  }
}

export class CodexCliAuthError extends CodexCliError {
  constructor(message: string, stderr?: string) {
    super(message, stderr);
    this.name = "CodexCliAuthError";
  }
}

export type CreateCodexCliBackendOptions = {
  /** Path to the `codex` binary. Default "codex" (env NOELLE_CODEX_CLI_PATH). */
  cliPath?: string;
  /** Per-call wall-clock budget. Default 180s (env NOELLE_CODEX_CLI_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Replace child_process.spawn (testing only). */
  spawnImpl?: typeof nodeSpawn;
  /** Where the operator's real codex config lives. Default ~/.codex. */
  codexHome?: string;
};

/**
 * Optional model pin. EMPTY BY DEFAULT on purpose: a ChatGPT account does not
 * accept every model name the CLI knows, and naming one it rejects fails the
 * whole call — `-m gpt-5-codex` returns
 *   "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT
 *    account."
 * with status 400 and an EMPTY stderr. Letting Codex choose its own default is
 * the only option that works across account types. Set NOELLE_CODEX_CLI_MODEL
 * to override, and expect a 400 if the account cannot serve it.
 */
function codexCliModel(): string { return process.env.NOELLE_CODEX_CLI_MODEL?.trim() || ""; }
/** Import-time compatibility snapshot; dispatch resolves the current operator pin. */
export const CODEX_CLI_MODEL = codexCliModel();

export function buildCodexCliArgv(
  answerFile: string,
  model: string,
  reasoningEffort?: "low" | "medium" | "high" | "xhigh",
): string[] {
  return [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    ...(model ? ["-m", model] : []),
    ...(reasoningEffort ? ["-c", `model_reasoning_effort="${reasoningEffort}"`] : []),
    "-o",
    answerFile,
    "-",
  ];
}

/**
 * Stripped from the child's environment so the CLI can ONLY use its ChatGPT
 * OAuth. Any of these would route to a billed API key instead — defeating the
 * point of the backend, and silently spending real money.
 */
const SANITIZED_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "CODEX_API_KEY",
] as const;

const AUTH_PATTERN = /not logged in|unauthorized|invalid api key|login|401/i;

export function createCodexCliBackend(
  opts?: CreateCodexCliBackendOptions,
): EngineBackend {
  const cliPath = opts?.cliPath ?? process.env.NOELLE_CODEX_CLI_PATH?.trim() ?? "codex";
  const configuredTimeout = process.env.NOELLE_CODEX_CLI_TIMEOUT_MS?.trim();
  const defaultTimeoutMs =
    opts?.timeoutMs ?? (configuredTimeout ? Number(configuredTimeout) : 180_000);
  const spawn = opts?.spawnImpl ?? nodeSpawn;
  const realHome = opts?.codexHome ?? join(homedir(), ".codex");

  return {
    async call(args) {
      let home: string | undefined;
      try {
        try {
          const timeoutMs = cliTimeoutMs(args.timeoutMs ?? defaultTimeoutMs);
          home = mkdtempSync(join(tmpdir(), "noelle-codex-"));
          const answerFile = join(home, "answer.txt");
          try { copyFileSync(join(realHome, "auth.json"), join(home, "auth.json")); }
          catch { throw new CodexCliAuthError(`codex cli: no auth.json under ${realHome}`); }
          const childEnv: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
          for (const key of SANITIZED_KEYS) delete childEnv[key];
          const { stdout, stderr, code } = await runCliProcess({
            command: cliPath, argv: buildCodexCliArgv(answerFile, codexCliModel(), args.reasoningEffort),
            prompt: args.system ? `${args.system}\n\n${args.prompt}` : args.prompt,
            timeoutMs, cwd: tmpdir(), env: childEnv, spawnImpl: spawn,
          });
          let text = "";
          try { text = readCliAnswer(answerFile); }
          catch (error) { if (error instanceof CliProcessError) throw error; }
          if (code === 0 && text) return { text, usage: parseCodexUsage(stdout) };
          const detail = parseCodexError(stdout);
          if (AUTH_PATTERN.test(stderr) || (detail && AUTH_PATTERN.test(detail))) {
            throw new CodexCliAuthError(`codex cli auth failure: ${detail ?? "see stderr"}`, stderr);
          }
          if (detail) throw new CodexCliError(`codex cli failed: ${detail}`, stderr);
          if (code !== 0) throw new CodexCliError(`codex cli exited ${code ?? "null"}`, stderr);
          throw new CodexCliError("codex cli returned no final message", stderr);
        } finally {
          if (home) rmSync(home, { recursive: true, force: true });
        }
      } catch (error) {
        if (error instanceof CodexCliError) throw error;
        const reason = error instanceof CliProcessError ? error.code : "failed";
        const detail = reason === "timed_out" ? `timed out after ${args.timeoutMs ?? defaultTimeoutMs}ms` : reason;
        throw new CodexCliError(`codex cli ${detail}`, error instanceof CliProcessError ? error.stderr : undefined);
      }
    },
  };
}

/**
 * Pull usage out of the JSONL event stream. Codex reports it once, on
 * `turn.completed`. `cached_input_tokens` is a SUBSET of `input_tokens` (not an
 * addition, unlike Anthropic's cache fields), so it must not be added again —
 * doing so would double-count the prefix and overstate the budget.
 * `reasoning_output_tokens` likewise counts inside `output_tokens`.
 */
export function parseCodexUsage(stdout: string): TokenUsage {
  let input = 0;
  let output = 0;
  let found = false;
  let inputReported = true;
  let outputReported = true;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const d = JSON.parse(t) as {
        type?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (d.type !== "turn.completed" || !d.usage) continue;
      found = true;
      if (isAccountingInteger(d.usage.input_tokens)) input += d.usage.input_tokens;
      else inputReported = false;
      if (isAccountingInteger(d.usage.output_tokens)) output += d.usage.output_tokens;
      else outputReported = false;
    } catch {
      /* a partial line is not fatal — usage is best-effort */
    }
  }
  return normalizeTokenUsage(found && inputReported ? input : undefined, found && outputReported ? output : undefined);
}

/**
 * Pull the human-readable reason out of an `error` / `turn.failed` event. Codex
 * nests the API's JSON error inside a string field, so unwrap one level when it
 * parses — otherwise the operator reads an escaped blob.
 */
export function parseCodexError(stdout: string): string | null {

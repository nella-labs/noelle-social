import { CLAUDE_CLI_MODEL } from "@noelle/runtime";

/**
 * What an agent ACTUALLY runs, resolved the way the workers resolve it.
 *
 * The agent Configuration panel used to fall back to design fixtures —
 * "sonnet 4.6 → opus 4.7 fallback" on a "residential vm". `model_overrides` is
 * unset in practice, so every org saw those strings; `opus 4.7` is not a model
 * that exists anywhere in this codebase; and Escalation and Runtime had no
 * real-data path at all. The panel described a demo, not the deployment.
 *
 * The env flags below are the SAME ones engineRegistryFromEnv uses to wire the
 * backends, and the model string is imported from the runtime rather than
 * restated — hand-kept copies of that literal have drifted before.
 */
export type RuntimeConfigView = {
  primary: string;
  fallback: string;
  escalation: string;
  runtime: string;
};

export type RuntimeConfigEnv = {
  claudeCli?: string | undefined;
  codexCli?: string | undefined;
  codexFailover?: string | undefined;
};

export function resolveRuntimeConfig(
  overrides: { primary?: string | undefined; fallback?: string | undefined },
  env: RuntimeConfigEnv,
  claudeModel: string = CLAUDE_CLI_MODEL,
): RuntimeConfigView {
  const claudeCli = env.claudeCli === "1";
  const codexCli = env.codexCli === "1";
  // Failover is on by default once a codex backend is wired; only an explicit
  // "0" turns it off. Mirrors codexFailoverEnabled() in the runtime.
  const codexFailover = codexCli && env.codexFailover !== "0";

  const primary =
    overrides.primary ??
    (claudeCli ? `${claudeModel} · claude subscription` : "bedrock");

  // The routing fallback and the BUDGET failover are different things: the
  // first catches an engine error, the second catches a spent cap. Only the
  // second involves ChatGPT.
  const fallback =
    overrides.fallback ??
    (codexCli
      ? "codex · chatgpt subscription"
      : claudeCli
        ? `${claudeModel} · retry`
        : "bedrock");

  return {
    primary,
    fallback,
    escalation: codexFailover ? "budget spent → chatgpt" : "—",
    runtime: claudeCli || codexCli ? "local cli on this vm" : "bedrock api",
  };
}

/**
 * How the budget window should be described, and when it actually rolls over.
 *
 * The panel said "% used this month" and "resets in 14d" — the first hardcoded,
 * the second read off a design fixture. Both became wrong the moment the cap
 * moved to a weekly window: a monthly cap does not pace anything, since a
 * runaway can spend the month in two days and then sit dark.
 *
 * Weeks are Monday-based, matching Postgres `date_trunc('week', …)` — the same
 * boundary the spend query resets on, so the number here cannot disagree with
 * the number the cap enforces.
 */
export function budgetWindow(
  period: string | undefined,
  now: Date = new Date(),
): { label: string; resetsInDays: number } {
  if (period === "week") {
    const dow = now.getDay(); // 0 = Sunday
    // Days until next Monday 00:00; Monday itself has a full 7 to run.
    const daysToMonday = dow === 0 ? 1 : 8 - dow;
    return { label: "this week", resetsInDays: daysToMonday };
  }
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const days = Math.ceil((next.getTime() - now.getTime()) / 86_400_000);
  return { label: "this month", resetsInDays: Math.max(days, 0) };
}

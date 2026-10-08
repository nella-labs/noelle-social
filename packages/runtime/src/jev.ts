import { experimental_evaluate as evaluate } from "ai";

export const JEV_MODEL = "typesafe-ai/jev";

type BooleanQuestion = {
  type: "boolean";
  instructions: string;
  criteria?: { true?: string; false?: string };
};
type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};
type JevQuestion = BooleanQuestion | ChoiceQuestion;
export type JevRun = (input: {
  model: typeof JEV_MODEL;
  state: string;
  questions: Record<string, JevQuestion>;
}) => Promise<{ answers: Record<string, unknown> }>;

export type JevBooleanDecision =
  | { kind: "confident"; pass: boolean; probability: number; provider: "jev" }
  | { kind: "uncertain"; probability: number; provider: "jev" }
  | { kind: "unavailable"; provider: "jev" };

export type JevChoiceDecision =
  | { kind: "choice"; choice: string; probability: number; probabilities: Record<string, number>; provider: "jev" }
  | { kind: "unavailable"; provider: "jev" };

type JevInput = { state: unknown; instructions: string; run?: JevRun; directFetch?: typeof fetch };
type BooleanInput = JevInput & { criteria?: { true: string; false: string } };
type ChoiceInput = JevInput & { criteria: Record<string, string> };

const validProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

function toState(state: unknown): string {
  return typeof state === "string" ? state : JSON.stringify(state);
}

let gatewayRateLimitedUntil = 0;
let directRateLimitedUntil = 0;
function isRateLimited(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { statusCode?: unknown; status?: unknown; name?: unknown; errors?: unknown; lastError?: unknown };
  if (value.statusCode === 429 || value.status === 429 || value.name === "GatewayRateLimitError") return true;
  if (Array.isArray(value.errors) && value.errors.some(isRateLimited)) return true;
  return value.lastError ? isRateLimited(value.lastError) : false;
}

function normalizeDirectAnswers(answers: unknown, questions: Record<string, JevQuestion>): Record<string, unknown> | null {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const entries = Object.entries(questions).map(([name, question]): [string, unknown] | null => {
    const answer = (answers as Record<string, unknown>)[name];
    if (!answer || typeof answer !== "object") return null;
    const value = answer as Record<string, unknown>;
    if (question.type === "boolean") {
      return value.type === "noul" && validProbability(value.noul)
        ? [name, { type: "boolean", probability: value.noul }] : null;
    }
    if (value.type !== "choice" || typeof value.choice !== "string" ||
        !Object.hasOwn(question.criteria, value.choice) || !value.probabilities ||
        typeof value.probabilities !== "object") return null;
    const probabilities = value.probabilities as Record<string, unknown>;
    return Object.keys(question.criteria).every((option) => validProbability(probabilities[option]))
      ? [name, { type: "choice", choice: value.choice, probabilities }] : null;
  });
  return entries.some((entry) => !entry) ? null : Object.fromEntries(entries as Array<[string, unknown]>);
}

async function runDirectJev(
  state: string, questions: Record<string, JevQuestion>, apiKey: string, send: typeof fetch,
): Promise<Record<string, unknown> | null> {
  const directQuestions = Object.fromEntries(Object.entries(questions).map(([name, question]) => [
    name, question.type === "boolean" ? { ...question, type: "noul" } : question,
  ]));
  const response = await send("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: "jev-latest", questions: directQuestions }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    if (response.status === 429 || response.status === 529) directRateLimitedUntil = Date.now() + 60_000;
    return null;
  }
  const body: unknown = await response.json();
  return normalizeDirectAnswers((body as { answers?: unknown } | null)?.answers, questions);
}

async function runJev(input: JevInput, questions: Record<string, JevQuestion>): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  // An injected Gateway run keeps existing tests deterministic unless a direct
  // fetch is also supplied to exercise transport fallback.
  if (apiKey && (!input.run || input.directFetch) && Date.now() >= directRateLimitedUntil) {
    try {
      const answers = await runDirectJev(toState(input.state), questions, apiKey, input.directFetch ?? fetch);
      if (answers) return answers;
    } catch { /* Gateway Jev remains the next transport. */ }
  }
  // A missing backend credential must never trigger an implicit unauthenticated request.
  if (!input.run && !process.env.AI_GATEWAY_API_KEY) return null;
  if (Date.now() < gatewayRateLimitedUntil) return null;
  try {
    const args = { model: JEV_MODEL, state: toState(input.state), questions } as const;
    // The free Gateway tier can return 429 on a burst. The SDK's default two
    // retries amplify that burst, so return the observation to its retry queue.
    const result = input.run ? await input.run(args) : await evaluate({ ...args, maxRetries: 0 });
    return result.answers;
  } catch (error) {
    if (isRateLimited(error)) gatewayRateLimitedUntil = Date.now() + 60_000;
    return null;
  }
}

function booleanDecision(answer: unknown): JevBooleanDecision {
  if (!answer || typeof answer !== "object") return { kind: "unavailable", provider: "jev" };
  const value = answer as { type?: unknown; probability?: unknown };
  if (value.type !== "boolean" || !validProbability(value.probability)) return { kind: "unavailable", provider: "jev" };
  if (value.probability >= 0.8 || value.probability < 0.4) {
    return { kind: "confident", pass: value.probability >= 0.8, probability: value.probability, provider: "jev" };
  }
  return { kind: "uncertain", probability: value.probability, provider: "jev" };
}

export async function evaluateJevBoolean(input: BooleanInput): Promise<JevBooleanDecision> {
  const answers = await runJev(input, { answer: { type: "boolean", instructions: input.instructions, ...(input.criteria ? { criteria: input.criteria } : {}) } });
  return booleanDecision(answers?.answer);
}

/** One round trip for independent narrow questions about the same item. */
export async function evaluateJevBooleans(input: {
  state: unknown;
  questions: Record<string, Omit<BooleanQuestion, "type">>;
  run?: JevRun;
  directFetch?: typeof fetch;
}): Promise<Record<string, JevBooleanDecision>> {
  const questions = Object.fromEntries(Object.entries(input.questions).map(([name, question]) => [name, { ...question, type: "boolean" as const }]));
  const answers = await runJev({ state: input.state, instructions: "", ...(input.run ? { run: input.run } : {}), ...(input.directFetch ? { directFetch: input.directFetch } : {}) }, questions);
  return Object.fromEntries(Object.keys(questions).map((name) => [name, booleanDecision(answers?.[name])]));
}

export async function evaluateJevChoice(input: ChoiceInput): Promise<JevChoiceDecision> {
  const options = Object.keys(input.criteria);
  if (options.length < 2) return { kind: "unavailable", provider: "jev" };
  const answers = await runJev(input, { answer: { type: "choice", instructions: input.instructions, criteria: input.criteria } });
  const answer = answers?.answer;
  if (!answer || typeof answer !== "object") return { kind: "unavailable", provider: "jev" };
  const value = answer as { type?: unknown; choice?: unknown; probabilities?: unknown };
  if (value.type !== "choice" || typeof value.choice !== "string" || !options.includes(value.choice) ||
      !value.probabilities || typeof value.probabilities !== "object") return { kind: "unavailable", provider: "jev" };
  const probabilities = value.probabilities as Record<string, unknown>;
  if (!options.every((option) => validProbability(probabilities[option]))) return { kind: "unavailable", provider: "jev" };
  return {
    kind: "choice", choice: value.choice, probability: probabilities[value.choice] as number,
    probabilities: probabilities as Record<string, number>, provider: "jev",
  };
}

/** Ordinary checks retain their current judge when Jev cannot return a clear answer. */
export async function withJevFallbackBoolean(input: BooleanInput & { legacy: () => Promise<boolean> }): Promise<{
  pass: boolean; provider: "jev" | "legacy" | "none"; judgeOk: boolean; probability?: number;
}> {
  const jev = await evaluateJevBoolean(input);
  if (jev.kind === "confident") return { pass: jev.pass, provider: "jev", judgeOk: true, probability: jev.probability };
  try {
    const pass = await input.legacy();
    if (typeof pass === "boolean") {
      return { pass, provider: "legacy", judgeOk: true, ...(jev.kind === "uncertain" ? { probability: jev.probability } : {}) };
    }
  } catch { /* no valid judge */ }
  return { pass: false, provider: "none", judgeOk: false, ...(jev.kind === "uncertain" ? { probability: jev.probability } : {}) };
}

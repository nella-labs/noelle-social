import { createBudgetedBackend, type BudgetDeps, type CallAgentModelArgs, type EngineBackend, type EngineKey } from "../callAgentModel.js";
import { isBudgetAdmissionError } from "../budgetAdmissionErrors.js";
import type { SpendRecorder } from "../spendRecorder.js";

export type CaptionMetering = {
  context: Pick<CallAgentModelArgs, "orgId" | "instanceId" | "agentRole" | "worker" | "bucket">;
  budget: BudgetDeps;
  recorder: SpendRecorder;
  /** Explicit accounting handle when a custom provider model ID is configured. */
  model?: string;
};

/** Caption calls reuse durable model admission and receipt settlement without provider fallback. */
export async function runCaptionModel(args: {
  engine: EngineKey; model: string; prompt: string; images: ReadonlyArray<{ data: string }>;
  timeoutMs: number; metering?: CaptionMetering; call: EngineBackend["call"]; failOpen?: boolean;
}): Promise<string> {
  let backend: EngineBackend = { call: args.call };
  if (args.metering) backend = createBudgetedBackend(backend, { engine: args.engine,
    context: args.metering.context, budget: args.metering.budget, recorder: args.metering.recorder });
  // The existing character estimator sees the bounded encoded image input.
  // This reserves estimated capacity; encoded length is not an image-token bill.
  const prompt = args.metering ? [args.prompt, ...args.images.map((image) => image.data)].join("\n") : args.prompt;
  try {
    const result = await backend.call({ system: "", prompt, model: args.metering?.model ?? args.model, timeoutMs: args.timeoutMs });
    return result.text.trim();
  } catch (error) {
    if (isBudgetAdmissionError(error) || !args.failOpen) throw error;
    return "";
  }
}

import {
  runPatternBreaker,
  runPatternRefine,
  type PatternBreakerTickArgs,
  type PatternRefineTickArgs,
} from "@noelle/runtime/pattern-breaker-db";
import type { ActiveInstance } from "../lib/activation.js";
import type { CodexRunner } from "../lib/codex-runner.js";
import { linkedinInternRouting } from "../lib/routing.js";

type WorkerContext = { instance: ActiveInstance; runner: Pick<CodexRunner, "draft"> };
export type RunPatternBreakerTickArgs = Omit<PatternBreakerTickArgs, "call"> & WorkerContext;
export type RunPatternRefineTickArgs = Omit<PatternRefineTickArgs, "call"> & WorkerContext;
function modelCall({ instance, runner }: WorkerContext) {
  return (system: string, prompt: string) =>
    runner
      .draft({
        bucket: "ideation",
        routing: linkedinInternRouting(instance),
        orgId: instance.org_id,
        instanceId: instance.id,
        worker: "pattern-breaker",
        agentRole: "linkedin_intern",
        system,
        prompt,
      })
      .then((result) => result.text);
}
export function runPatternBreakerTick(args: RunPatternBreakerTickArgs): Promise<number> {
  return runPatternBreaker({ ...args, call: modelCall(args) });
}
export function runPatternRefineTick(args: RunPatternRefineTickArgs): Promise<number> {
  return runPatternRefine({ ...args, call: modelCall(args) });
}

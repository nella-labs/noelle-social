import type { PatternFinding } from "@noelle/contracts";
import type { Bus } from "../bus.js";
import {
  analyzePatterns,
  refineRule,
  DEFAULT_WINDOWS,
  type PatternAnalyzerCall,
} from "./analyze.js";
import type { RecentPost } from "./dbCorpus.js";
import type { RefiningAlertRow } from "./dbReads.js";
import type { CapturedPatternClaim } from "./dbMutations.js";

interface PatternLogger {
  info: (data: object, message: string) => void;
  warn: (data: object, message: string) => void;
  error: (data: object, message: string) => void;
}
export interface PatternBreakerTickArgs {
  log: PatternLogger;
  call: PatternAnalyzerCall;
  loadCorpus: () => Promise<RecentPost[]>;
  loadExistingLabels: () => Promise<string[]>;
  persist: (
    finding: PatternFinding,
    windowSize: number,
    corpus: RecentPost[],
  ) => Promise<{ ruleId: string; alertId: string } | null>;
  bus?: Bus;
  windows?: number[];
  minFrequency?: number;
  minRatio?: number;
  appendVaultNote?: (note: { label: string; instruction: string }) => Promise<void>;
}
/** Observations refer only to the captured, admitted corpus; duplicate or rejected writes emit no success. */
export async function runPatternBreaker(args: PatternBreakerTickArgs): Promise<number> {
  const posts = await args.loadCorpus();
  if (posts.length < (args.minFrequency ?? 3)) return 0;
  // An unavailable rule set is not evidence of an empty set. No analyst dispatch follows this failure.
  const existingLabels = await args.loadExistingLabels();
  const patterns = await analyzePatterns({
    posts,
    existingLabels,
    call: args.call,
    windows: args.windows ?? DEFAULT_WINDOWS,
    minFrequency: args.minFrequency ?? 3,
    minRatio: args.minRatio ?? 0.3,
  });
  let broken = 0;
  for (const { finding, windowSize } of patterns) {
    try {
      const persisted = await args.persist(finding, windowSize, posts);
      if (!persisted) continue;
      const { ruleId, alertId } = persisted;
      broken++;
      await args.bus?.emit({
        topic: "pattern.detected",
        worker: "pattern-breaker",
        severity: finding.severity === "high" ? "warn" : "info",
        summary: `over-used pattern: ${finding.label}`,
        payload: {
          alert_id: alertId,
          rule_id: ruleId,
          label: finding.label,
          kind: finding.kind,
          window_size: windowSize,
          frequency_count: finding.frequencyCount,
        },
        correlationId: alertId,
      });
      if (args.appendVaultNote) {
        await args
          .appendVaultNote({ label: finding.label, instruction: finding.instruction })
          .catch((error) =>
            args.log.warn(
              { err: (error as Error).message, label: finding.label },
              "pattern breaker: vault note failed",
            ),
          );
      }
    } catch (error) {
      args.log.error(
        { err: (error as Error).message, label: finding.label },
        "pattern breaker: observation publication failed",
      );
    }
  }
  args.log.info(
    { broken, candidates: patterns.length, corpus: posts.length },
    "pattern breaker tick complete",
  );
  return broken;
}
export interface PatternRefineTickArgs {
  log: PatternLogger;
  call: PatternAnalyzerCall;
  loadQueue: () => Promise<RefiningAlertRow[]>;
  claim: (item: RefiningAlertRow) => Promise<CapturedPatternClaim | null>;
  applyRefined: (args: {
    claim: CapturedPatternClaim;
    instruction: string | null;
  }) => Promise<boolean>;
  bus?: Bus;
}
/** Per-dispatch claims remain durable after uncertain calls or writes; recovery requires an explicit operator retry. */
export async function runPatternRefine(args: PatternRefineTickArgs): Promise<number> {
  const queue = await args.loadQueue();
  let refined = 0;
  for (const item of queue) {
    try {
      const claim = await args.claim(item);
      if (!claim) continue;
      const instruction = await refineRule({
        currentInstruction: claim.current_instruction,
        description: claim.description,
        examples: claim.examples,
        note: claim.refine_note,
        call: args.call,
      });
      const applied = await args.applyRefined({ claim, instruction });
      if (!applied) continue;
      refined++;
      await args.bus?.emit({
        topic: "pattern.refined",
        worker: "pattern-breaker",
        summary: `refined rule: ${claim.pattern_name}`,
        payload: { alert_id: claim.alert_id, rule_id: claim.rule_id, changed: true },
        correlationId: claim.alert_id,
      });
    } catch (error) {
      args.log.error(
        { err: (error as Error).message, alertId: item.alert_id },
        "pattern refine failed",
      );
    }
  }
  args.log.info({ refined, queued: queue.length }, "pattern refine tick complete");
  return refined;
}

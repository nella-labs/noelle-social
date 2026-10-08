// The stamper itself lives in @noelle/runtime/worker-runs (consolidated from the
// four per-app copies). This file survives ONLY to keep Lyra's worker-name union
// narrowed to what she may stamp into noelle.worker_runs — the dashboard reads
// that column, so the union must not widen to the other interns' kinds.
import { recordRun as recordRunAnyKind, type RecordRun } from "@noelle/runtime/worker-runs";

export type { RunHandle } from "@noelle/runtime/worker-runs";

// Lyra runs discovery → classifier → drafter (+ profiler). No send worker — it
// never posts to LinkedIn. The Posts lane adds ideation + post-drafter (also
// draft-only — they write idea cards / post drafts, never publish).
export type WorkerKind =
  | "discovery"
  | "classifier"
  | "profiler"
  | "drafter"
  | "ideation"
  | "post-drafter";

/** Same function, narrowed to Lyra's kinds. Type-only binding, no wrapper. */
export const recordRun: RecordRun<WorkerKind> = recordRunAnyKind;

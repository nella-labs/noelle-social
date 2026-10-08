// The stamper itself lives in @noelle/runtime/worker-runs — this app's copy was
// the SUPERSET the shared one adopted (instance_id + updateSummary +
// isCancelRequested, schema 0078). This file survives ONLY to keep Nova's
// worker-name union narrowed to what she may stamp into noelle.worker_runs; her
// kinds are disjoint from the three reply interns', so the union must not widen.
import { recordRun as recordRunAnyKind, type RecordRun } from "@noelle/runtime/worker-runs";

export type { RunHandle } from "@noelle/runtime/worker-runs";

// Nova runs harvester → teardown → distiller → scripter (+ ideator, skiller,
// briefer). No send worker — it never publishes; it produces scripts + briefs.
export type WorkerKind =
  | "harvester"
  | "teardown"
  | "distiller"
  | "scripter"
  | "ideator"
  | "skiller"
  | "briefer";

/** Same function, narrowed to Nova's kinds. Type-only binding, no wrapper. */
export const recordRun: RecordRun<WorkerKind> = recordRunAnyKind;

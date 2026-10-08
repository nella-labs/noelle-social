// Re-export shim — the worker loop implementation lives in
// @noelle/worker-runtime (one canonical copy for all intern apps).
export { runWorkerLoop, installShutdown, type RunWorkerLoopArgs } from "@noelle/worker-runtime";

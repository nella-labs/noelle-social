// Cooperative cancellation for the actuation loop.
//
// STOP (endRun) is already "authoritative" via the run epoch — a superseded or
// stopped run can't save its plan back or start a new action. But the epoch is
// only checked at tick boundaries, so an action already in flight — mid reading
// dwell, mid humanized mouse path, mid type — runs to completion before the loop
// notices. With ambient "…more"/comment reads that dwell can be tens of seconds,
// so STOP feels dead. These primitives let the in-flight work bail promptly:
//
//  - abortableSleep resolves the instant the run's AbortSignal fires, so every
//    dwell (and every sleep inside the CDP motion engine, which receives this
//    same sleep) collapses on STOP instead of waiting out its timer.
//  - throwIfAborted, called right before an action commits (the like click, the
//    comment/DM submit), unwinds through the existing try/catch so nothing lands
//    after STOP.

/** Sleep for `ms`, or resolve immediately if `signal` is (or becomes) aborted. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Sentinel thrown by throwIfAborted so callers/logs can recognize a STOP unwind. */
export class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof AbortError || (e instanceof Error && e.name === "AbortError");
}

/** Throw AbortError if the run has been stopped/superseded. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AbortError();
}

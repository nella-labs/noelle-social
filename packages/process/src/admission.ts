import { CliProcessError } from "./cliProcess.js";

export class ProcessAdmissionError extends Error {
  constructor(readonly code: "timeout" | "busy" | "cleanup_failed") {
    super(`Process admission ${code}`);
    this.name = "ProcessAdmissionError";
  }
}
type Item = {
  deadline: number;
  timer: NodeJS.Timeout;
  start(timeoutMs: number): Promise<void>;
  reject(error: unknown): void;
};

/** Four executing operations and 32 admitted requests share their original deadlines. */
export class BoundedProcessQueue {
  private active = 0;
  private queue: Item[] = [];
  private closed = false;

  checkAvailable(): void {
    if (this.closed) throw new ProcessAdmissionError("cleanup_failed");
    if (this.active + this.queue.length >= 32) throw new ProcessAdmissionError("busy");
  }

  run<T>(deadline: number, operation: (timeoutMs: number) => Promise<T>): Promise<T> {
    try {
      this.checkAvailable();
    } catch (error) {
      return Promise.reject(error);
    }
    const remaining = Math.floor(deadline - performance.now());
    if (!Number.isFinite(remaining) || remaining < 1)
      return Promise.reject(new ProcessAdmissionError("timeout"));
    return new Promise<T>((resolve, reject) => {
      const item: Item = {
        deadline,
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(item);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(new ProcessAdmissionError("timeout"));
        }, remaining),
        start: async (timeoutMs) => {
          try {
            // The operation must own cancellation and settle only after its resources close.
            const value = await operation(timeoutMs);
            if (performance.now() >= deadline) throw new ProcessAdmissionError("timeout");
            resolve(value);
          } catch (error) {
            if (error instanceof CliProcessError && error.code === "cleanup_failed") {
              this.closed = true;
              for (const waiting of this.queue.splice(0)) {
                clearTimeout(waiting.timer);
                waiting.reject(new ProcessAdmissionError("cleanup_failed"));
              }
            }
            reject(error);
          }
        },
      };
      this.queue.push(item);
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < 4 && this.queue.length) {
      const item = this.queue.shift()!;
      clearTimeout(item.timer);
      const remaining = Math.floor(item.deadline - performance.now());
      if (remaining < 1) {
        item.reject(new ProcessAdmissionError("timeout"));
        continue;
      }
      this.active++;
      void item.start(remaining).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
}

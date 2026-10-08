import { fetchBoundedHttpResponse, httpBodyLimit } from "./boundedHttp.js";
import { cliTimeoutMs } from "./cliProcess.js";
import { BoundedProcessQueue } from "@noelle/process";

const admission = new BoundedProcessQueue();

export class GcsAuthenticationError extends Error {
  constructor() { super("GCS authentication unavailable"); this.name = "GcsAuthenticationError"; }
}
/** One deadline includes owned credentials and the complete native HTTP body. */
export function createGcsHttpRequest(options: {
  getAccessToken(timeoutMs: number): Promise<string | null | undefined>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}) {
  const timeout = cliTimeoutMs(options.timeoutMs ?? 20_000);
  return async (url: string | URL, init: RequestInit | (() => RequestInit) = {}, limits: { maxBytes?: number; timeoutMs?: number } = {}) => {
    const maxBytes = httpBodyLimit(limits.maxBytes);
    const budget = Math.min(timeout, cliTimeoutMs(limits.timeoutMs ?? timeout));
    const deadline = performance.now() + budget;
    return admission.run(deadline, async remainingBudget => {
      let token: string | null | undefined;
      try { token = await options.getAccessToken(Math.min(8000, remainingBudget)); }
      catch { throw new GcsAuthenticationError(); }
      if (typeof token !== "string" || !token.trim()) throw new GcsAuthenticationError();
      if (deadline - performance.now() < 1) throw new Error("GCS request timeout before dispatch");
      const requestInit = typeof init === "function" ? init() : init;
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) throw new Error("GCS request timeout before dispatch");
      const headers = new Headers(requestInit.headers); headers.set("authorization", `Bearer ${token}`);
      return fetchBoundedHttpResponse(url, { ...requestInit, headers }, {
        timeoutMs: remaining, maxBytes, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    });
  };
}

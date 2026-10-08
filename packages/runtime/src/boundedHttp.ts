export type HttpBodyErrorCode = "body_too_large" | "invalid_json" | "timeout" | "aborted" | "network";

/** Transport and decoding failures contain no request or response content. */
export class HttpBodyError extends Error {
  constructor(readonly code: HttpBodyErrorCode, message: string, readonly status?: number) {
    super(message); this.name = "HttpBodyError";
  }
}

export interface HttpBodyOptions { maxBytes?: number; signal?: AbortSignal }
export interface BoundedHttpOptions extends Omit<HttpBodyOptions, "signal"> {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_HTTP_TIMEOUT_MS = 1_800_000;
function bound(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1 || selected > maximum) {
    throw new RangeError(`Invalid HTTP ${name}`);
  }
  return selected;
}

/** Validate a body budget before starting authentication or transport. */
export function httpBodyLimit(value?: number): number {
  return bound(value, DEFAULT_BODY_BYTES, 16 * 1024 * 1024, "body limit");
}

function aborted(signal: AbortSignal, status?: number): HttpBodyError {
  return signal.reason instanceof HttpBodyError && signal.reason.code === "timeout"
    ? new HttpBodyError("timeout", signal.reason.message, status)
    : new HttpBodyError("aborted", "HTTP request aborted", status);
}

/** Read and bound actual streamed bytes; aborts cancel and await the owned reader. */
export async function readBoundedHttpBytes(response: Response, options: HttpBodyOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const maxBytes = httpBodyLimit(options.maxBytes);
  if (options.signal?.aborted) {
    await response.body?.cancel().catch(() => {});
    throw aborted(options.signal, response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let cancellation: Promise<void> | undefined;
  const cancel = () => { cancellation ??= reader.cancel().catch(() => {}); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  let buffer = new Uint8Array(Math.min(maxBytes, 65_536));
  let bytes = 0;
  try {
    while (true) {
      if (options.signal?.aborted) throw aborted(options.signal, response.status);
      const { value, done } = await reader.read();
      if (options.signal?.aborted) throw aborted(options.signal, response.status);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        cancel();
        throw new HttpBodyError("body_too_large", "HTTP response exceeds its byte limit", response.status);
      }
      if (bytes > buffer.length) {
        const expanded = new Uint8Array(Math.min(maxBytes, Math.max(bytes, buffer.length * 2)));
        expanded.set(buffer); buffer = expanded;
      }
      buffer.set(value, bytes - value.byteLength);
    }
    return buffer.slice(0, bytes);
  } catch (error) {
    cancel();
    if (options.signal?.aborted) throw aborted(options.signal, response.status);
    if (error instanceof HttpBodyError) throw error;
    throw new HttpBodyError("network", "HTTP response body failed", response.status);
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    await cancellation;
    reader.releaseLock();
  }
}

export function decodeHttpText(bytes: Uint8Array): string { return new TextDecoder().decode(bytes); }
export function decodeHttpJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(decodeHttpText(bytes)); }
  catch { throw new HttpBodyError("invalid_json", "HTTP response contains invalid JSON"); }
}
export async function readBoundedHttpText(response: Response, options?: HttpBodyOptions): Promise<string> {
  return decodeHttpText(await readBoundedHttpBytes(response, options));
}
export async function readBoundedHttpJson(response: Response, options?: HttpBodyOptions): Promise<unknown> {
  return decodeHttpJson(await readBoundedHttpBytes(response, options));
}

/** The deadline covers native fetch and the complete body, including HTTP errors. */
export async function fetchBoundedHttpResponse(
  input: RequestInfo | URL, init: RequestInit = {}, options: BoundedHttpOptions = {},
): Promise<{ response: Response; bytes: Uint8Array<ArrayBuffer> }> {
  const timeoutMs = bound(options.timeoutMs, 8000, MAX_HTTP_TIMEOUT_MS, "timeout");
  const maxBytes = httpBodyLimit(options.maxBytes);
  const controller = new AbortController();
  const parentSignal = init.signal ?? (input instanceof Request ? input.signal : undefined);
  const abort = () => controller.abort();
  parentSignal?.addEventListener("abort", abort, { once: true });
  if (parentSignal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(new HttpBodyError("timeout", "HTTP request timed out")), timeoutMs);
  try {
    if (controller.signal.aborted) throw aborted(controller.signal);
    const response = await (options.fetchImpl ?? fetch)(input, { ...init, signal: controller.signal });
    const bytes = await readBoundedHttpBytes(response, { maxBytes, signal: controller.signal });
    return { response, bytes };
  } catch (error) {
    if (error instanceof HttpBodyError) throw error;
    if (controller.signal.aborted) throw aborted(controller.signal);
    throw new HttpBodyError("network", "HTTP request failed");
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
}

/** Adapt SDK fetch hooks to the same full-body deadline and byte bound. */
export function createBoundedHttpFetch(options: BoundedHttpOptions = {}): typeof fetch {
  return async (input, init) => {
    const { response, bytes } = await fetchBoundedHttpResponse(input, init, options);
    return new Response(response.body === null ? null : bytes, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  };
}

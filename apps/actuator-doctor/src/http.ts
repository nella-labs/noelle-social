// Tiny fail-safe HTTP helpers for the probes + remediations. Everything here
// resolves (never rejects): a probe that throws would crash a tick, so network
// failures come back as a `status: null` result the caller interprets.
//
// fetch is called as `globalThis.fetch(...)` (not destructured) to avoid the
// "Illegal invocation" trap when the bound receiver is lost (see the actuators'
// api.ts note).

export interface HttpResult {
  // null => the request never got an HTTP response (DNS / connect / timeout).
  status: number | null;
  json: unknown;
  error?: string;
}

function withTimeout(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

export async function httpGet(
  url: string,
  opts: { timeoutMs: number; token?: string },
): Promise<HttpResult> {
  const { signal, cancel } = withTimeout(opts.timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
    const res = await globalThis.fetch(url, { signal, headers });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch (err) {
    return { status: null, json: null, error: String(err) };
  } finally {
    cancel();
  }
}

export async function httpPostJson(
  url: string,
  body: unknown,
  opts: { timeoutMs: number; token?: string },
): Promise<HttpResult> {
  const { signal, cancel } = withTimeout(opts.timeoutMs);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
    const res = await globalThis.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch (err) {
    return { status: null, json: null, error: String(err) };
  } finally {
    cancel();
  }
}

// HTTP client for the Chrome Bridge extension transport. Every call is fail-open:
// the bridge may be down (pm2 stopped, wrong port), and a debugging bridge that
// crashes the operator's Chrome would be worse than one that quietly does nothing.
// So each helper try/catches and returns null / void on any failure.
//
// IMPORTANT: fetch is captured ONCE, bound to the realm global. A bare `fetch`
// reference invoked with the wrong `this` throws "Illegal invocation" in a service
// worker — see apps/x-actuator/src/lib/api.ts. Bind it here and only ever call the
// bound handle.
import type {
  ChromeOpResult,
  ExtPollResponse,
  ExtHello,
  ExtEvent,
  Heartbeat,
} from "@noelle/contracts";
import { bridgeUrl } from "./config.js";

const f: typeof fetch = globalThis.fetch.bind(globalThis);
const JSON_HEADERS = { "content-type": "application/json" } as const;

// Fire a POST with a JSON body. Returns true on a 2xx, false on any error/non-2xx.
async function postJson(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await f(await bridgeUrl(path), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** GET /ext/poll → the ops the bridge has queued for this extension. */
export async function pollOps(): Promise<ExtPollResponse | null> {
  try {
    const res = await f(await bridgeUrl("/ext/poll"));
    if (!res.ok) return null;
    return (await res.json()) as ExtPollResponse;
  } catch {
    return null;
  }
}

/** POST /ext/result — report one completed op keyed by its correlation id. */
export async function reportResult(id: string, result: ChromeOpResult): Promise<void> {
  await postJson("/ext/result", { id, result });
}

/** POST /ext/hello — announce this extension (id/version/chrome/build) on connect. */
export async function hello(info: ExtHello): Promise<void> {
  await postJson("/ext/hello", info);
}

/** POST /ext/event — push an unsolicited event (console/tab/debugger). */
export async function event(ev: ExtEvent): Promise<void> {
  await postJson("/ext/event", ev);
}

/** POST /ingest/heartbeat — stamp liveness on the shared bridge sink. */
export async function heartbeat(hb: Heartbeat): Promise<void> {
  await postJson("/ingest/heartbeat", hb);
}

/** GET /ext/build → the on-disk build stamp, for self-reload. Null when the bridge
 * is down or has no readable stamp (fail-soft: the caller then does nothing). */
export async function getBuild(): Promise<{ stamp: string | null } | null> {
  try {
    const res = await f(await bridgeUrl("/ext/build"));
    if (!res.ok) return null;
    const body = (await res.json()) as { stamp?: unknown };
    return { stamp: typeof body.stamp === "string" ? body.stamp : null };
  } catch {
    return null;
  }
}

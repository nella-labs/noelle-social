// The fixed program owns only canonical SSR session loading and refresh.
import { parentPort, workerData } from "node:worker_threads";
import process from "node:process";
import { createServerClient } from "@supabase/ssr";
import { createBoundedHttpFetch, HttpBodyError } from "@noelle/runtime/bounded-http";

const remaining = () => Number((workerData.deadlineNs - process.hrtime.bigint()) / 1_000_000n);
const updates = new Map();
let lastStatus, transportFailed = false;
try {
  if (remaining() < 1) throw new Error("Session admission expired");
  const client = createServerClient(workerData.url, workerData.anonKey, {
    cookieOptions: { name: workerData.cookieName },
    cookies: {
      getAll: () => workerData.cookies,
      setAll: rows => { for (const row of rows) updates.set(row.name, row); },
    },
    global: {
      fetch: async (input, init) => {
        try {
          const timeoutMs = remaining();
          if (timeoutMs < 1) throw new HttpBodyError("timeout", "Session admission expired");
          const response = await createBoundedHttpFetch({ timeoutMs, maxBytes: 65_536 })(input, init);
          lastStatus = response.status;
          return response;
        } catch (error) { transportFailed = true; throw error; }
      },
    },
  });
  const result = await client.auth.getSession();
  const accessToken = result.data.session?.access_token ?? null;
  const knownRejection = !transportFailed && lastStatus >= 400 && lastStatus < 500 && ![408, 429].includes(lastStatus);
  const unavailable = result.error && !knownRejection || lastStatus === 200 && !accessToken;
  parentPort.postMessage({ accessToken: unavailable ? null : accessToken,
    ...(result.error || unavailable ? { error: unavailable ? "unavailable" : "rejected" } : {}),
    cookies: unavailable ? [] : [...updates.values()] });
} catch {
  parentPort.postMessage({ accessToken: null, cookies: [], error: "unavailable" });
} finally {
  parentPort.close();
}

import type { MiddlewareHandler } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadEnv } from "../env.js";

// HMAC-SHA256 auth for VM↔VM endpoints (e.g. drafter → POST /api/outbound).
// Signature scheme:
//   X-Noelle-Timestamp: <unix-seconds>
//   X-Noelle-Signature: sha256=<hex>
//   sig = HMAC_SHA256(NOELLE_HMAC_SECRET, `${timestamp}.${body}`)
// 5-minute replay window.

const REPLAY_WINDOW_SECONDS = 300;

export const requireHmac: MiddlewareHandler = async (c, next) => {
  const env = loadEnv();
  const ts = c.req.header("x-noelle-timestamp");
  const sig = c.req.header("x-noelle-signature");

  if (!ts || !sig) return c.json({ error: "missing_hmac_headers" }, 401);

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return c.json({ error: "bad_timestamp" }, 401);

  const skew = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (skew > REPLAY_WINDOW_SECONDS) {
    return c.json({ error: "timestamp_out_of_window" }, 401);
  }

  // Read body once; downstream handlers re-parse via c.req.json() (Hono
  // caches the raw body so re-reads don't drain).
  const raw = await c.req.text();
  const expected = createHmac("sha256", env.NOELLE_HMAC_SECRET)
    .update(`${ts}.${raw}`)
    .digest("hex");
  const expectedFull = `sha256=${expected}`;

  let provided: Buffer;
  let expectedBuf: Buffer;
  try {
    provided = Buffer.from(sig);
    expectedBuf = Buffer.from(expectedFull);
  } catch {
    return c.json({ error: "bad_signature_encoding" }, 401);
  }
  if (provided.length !== expectedBuf.length) {
    return c.json({ error: "bad_signature" }, 401);
  }
  if (!timingSafeEqual(provided, expectedBuf)) {
    return c.json({ error: "bad_signature" }, 401);
  }

  // Stash the raw body so handlers don't pay the parse cost twice. Hono
  // hides this behind c.req.parseBody, but downstream we use c.req.json().
  c.set("rawBody", raw);
  await next();
};

// Helper exported for the drafter / tests to compute a matching signature.
export function signHmacBody(secret: string, timestamp: number, body: string) {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return { signature: `sha256=${sig}`, timestamp: String(timestamp) };
}

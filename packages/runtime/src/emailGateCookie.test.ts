import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";

/**
 * Cross-runtime parity test for the `noelle_email_verified` cookie.
 *
 * Background: apps/app signs the cookie with `node:crypto` inside
 * `apps/app/src/app/auth/gate/route.ts` (Node Serverless route), and
 * verifies it with the Web Crypto API inside `apps/app/src/middleware.ts`
 * (Edge runtime). If the two implementations produce different bytes for
 * the same `(email, secret)` pair, every redirect from /auth/gate sets a
 * cookie that middleware will immediately reject — bouncing the user
 * straight back to the gate in an infinite loop.
 *
 * This test pins the contract: hex(HMAC-SHA256(secret, email)) must
 * agree across both crypto stacks, AND a tampered email must fail
 * verification. We don't import either app module (Edge code can't be
 * loaded under Node Vitest anyway) — we verify the primitive both sides
 * agree on.
 */

const SECRET = "test-secret-for-gate-cookie";

function nodeSign(email: string): string {
  return createHmac("sha256", SECRET).update(email).digest("hex");
}

async function webSign(email: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(email));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("email-gate cookie HMAC parity", () => {
  it("Node and Web Crypto sign identical bytes for the same input", async () => {
    const email = "operator@example.test";
    const a = nodeSign(email);
    const b = await webSign(email);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a tampered email under both signers", async () => {
    const real = "operator@example.test";
    const forged = "attacker@evil.com";
    const realSig = nodeSign(real);
    expect(await webSign(forged)).not.toBe(realSig);
    expect(nodeSign(forged)).not.toBe(realSig);
  });

  it("rejects a flipped-bit signature", async () => {
    const email = "operator@example.test";
    const sig = nodeSign(email);
    const tamperedHex = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    const expected = await webSign(email);
    expect(tamperedHex).not.toBe(expected);
  });

  it("is sensitive to email case (callers must lowercase before signing)", async () => {
    const lower = "operator@example.test";
    const mixed = "Operator@Example.test";
    expect(nodeSign(lower)).not.toBe(nodeSign(mixed));
  });
});

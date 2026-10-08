import { describe, expect, it } from "vitest";
import { jwtVerify } from "jose";
import { generateSecret, jwtExp, jwtNeedsRemint, mintOperatorJwt } from "./identity.js";

describe("generateSecret", () => {
  it("produces a url-safe secret of the requested entropy", () => {
    const s = generateSecret(48);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBeGreaterThanOrEqual(60);
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

describe("mintOperatorJwt", () => {
  it("mints an HS256 token verifiable with the same secret", async () => {
    const secret = generateSecret(48);
    const token = await mintOperatorJwt({
      secret,
      sub: "be2fb26e-5b29-40d8-a593-a5642b3d49b3",
      email: "op@example.com",
    });
    const { payload, protectedHeader } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
    );
    expect(protectedHeader.alg).toBe("HS256");
    expect(payload.sub).toBe("be2fb26e-5b29-40d8-a593-a5642b3d49b3");
    expect(payload.email).toBe("op@example.com");
    expect(payload.role).toBe("authenticated");
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("a wrong secret fails verification", async () => {
    const token = await mintOperatorJwt({ secret: generateSecret(), sub: "u", email: "e" });
    await expect(
      jwtVerify(token, new TextEncoder().encode(generateSecret())),
    ).rejects.toBeTruthy();
  });
});

describe("jwtNeedsRemint", () => {
  const WEEK = 7 * 24 * 3600;

  it("true for a missing or unreadable token", () => {
    expect(jwtNeedsRemint(undefined, WEEK)).toBe(true);
    expect(jwtNeedsRemint("", WEEK)).toBe(true);
    expect(jwtNeedsRemint("not-a-jwt", WEEK)).toBe(true);
    expect(jwtNeedsRemint("a.b.c", WEEK)).toBe(true);
  });

  it("true for an expired token and one inside the re-mint window", async () => {
    const secret = generateSecret();
    const expired = await mintOperatorJwt({ secret, sub: "u", email: "e", expiresIn: "1s" });
    expect(jwtNeedsRemint(expired, WEEK, Date.now() + 5_000)).toBe(true);
    const closeCall = await mintOperatorJwt({ secret, sub: "u", email: "e", expiresIn: "3d" });
    expect(jwtNeedsRemint(closeCall, WEEK)).toBe(true);
  });

  it("false for a token with plenty of lifetime left (fresh 30d mint)", async () => {
    const fresh = await mintOperatorJwt({ secret: generateSecret(), sub: "u", email: "e" });
    expect(jwtNeedsRemint(fresh, WEEK)).toBe(false);
    expect(jwtExp(fresh)).toBeGreaterThan(Date.now() / 1000 + 20 * 24 * 3600);
  });
});

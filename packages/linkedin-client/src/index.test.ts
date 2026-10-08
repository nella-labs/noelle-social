import { describe, expect, it } from "vitest";
import {
  createLinkedInClient,
  LinkedInAuthError,
  LinkedInRateLimitError,
  profileSlug,
  type CreateLinkedInClientOpts,
} from "./index.js";

// ---- fake fetch plumbing -------------------------------------------------

function mintResponse(jsession = 'ajax:test-123'): Response {
  const h = new Headers();
  h.append("set-cookie", `JSESSIONID="${jsession}"; Path=/; Secure`);
  h.append("set-cookie", `lidc="b=TEST"; Path=/`);
  return new Response(null, { status: 200, headers: h });
}
function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function statusResponse(status: number, body = ""): Response {
  return new Response(body, { status });
}

/** Build a client whose fetch is driven by a url->Response[] router (FIFO). */
function clientWith(
  routes: (url: string, calls: number) => Response,
  extra: Partial<CreateLinkedInClientOpts> = {},
) {
  let n = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return routes(url, n++);
  }) as unknown as typeof fetch;
  return createLinkedInClient({
    liAt: "AQ-test-li-at",
    minDelayMs: 0,
    sleepImpl: async () => {},
    fetchImpl,
    ...extra,
  });
}

// ---- helpers -------------------------------------------------------------

describe("profileSlug", () => {
  it("extracts the slug from a profile URL and strips @", () => {
    expect(profileSlug("https://www.linkedin.com/in/bosco-maldonado/")).toBe("bosco-maldonado");
    expect(profileSlug("@some-handle")).toBe("some-handle");
    expect(profileSlug("plain-slug")).toBe("plain-slug");
  });
});

// ---- session minting -----------------------------------------------------

describe("session minting", () => {
  it("mints a fresh JSESSIONID from li_at and uses it as the csrf-token", async () => {
    let voyagerHeaders: Headers | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/feed/")) return mintResponse("ajax:fresh-999");
      voyagerHeaders = new Headers(init?.headers);
      return jsonResponse({ data: { "*miniProfile": "urn:li:fs_miniProfile:ABC123" }, included: [] });
    }) as unknown as typeof fetch;

    const li = createLinkedInClient({ liAt: "x", minDelayMs: 0, sleepImpl: async () => {}, fetchImpl });
    const me = await li.me();
    expect(me.fsdProfileId).toBe("ABC123");
    expect(voyagerHeaders?.get("csrf-token")).toBe("ajax:fresh-999");
    expect(voyagerHeaders?.get("cookie")).toContain('JSESSIONID="ajax:fresh-999"');
    expect(voyagerHeaders?.get("cookie")).toContain("li_at=x");
  });

  it("throws LinkedInAuthError when no JSESSIONID is minted (bad li_at / blocked IP)", async () => {
    const li = clientWith((url) =>
      url.includes("/feed/") ? new Response(null, { status: 302 }) : jsonResponse({}),
    );
    await expect(li.me()).rejects.toBeInstanceOf(LinkedInAuthError);
  });

  it("uses a supplied JSESSIONID directly and skips /feed/ minting", async () => {
    let mints = 0;
    let csrfSent = "";
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/feed/")) {
        mints++;
        return mintResponse();
      }
      csrfSent = new Headers(init?.headers).get("csrf-token") ?? "";
      return jsonResponse({ data: { "*miniProfile": "urn:li:fs_miniProfile:OK" }, included: [] });
    }) as unknown as typeof fetch;
    const li = createLinkedInClient({
      liAt: "x",
      jsessionid: "ajax:supplied-123",
      minDelayMs: 0,
      sleepImpl: async () => {},
      fetchImpl,
    });
    await li.me();
    expect(mints).toBe(0); // never hit /feed/
    expect(csrfSent).toBe("ajax:supplied-123");
  });
});

// ---- error handling ------------------------------------------------------

describe("voyager error handling", () => {
  it("re-mints once on 403 then succeeds", async () => {
    let voyagerCalls = 0;
    const li = clientWith((url) => {
      if (url.includes("/feed/")) return mintResponse();
      voyagerCalls++;
      if (voyagerCalls === 1) return statusResponse(403, "CSRF check failed.");
      return jsonResponse({ data: { "*miniProfile": "urn:li:fs_miniProfile:OK" }, included: [] });
    });
    const me = await li.me();
    expect(me.fsdProfileId).toBe("OK");
    expect(voyagerCalls).toBe(2);
  });

  it("throws LinkedInAuthError when 403 persists after re-mint", async () => {
    const li = clientWith((url) =>
      url.includes("/feed/") ? mintResponse() : statusResponse(403, "CSRF check failed."),
    );
    await expect(li.me()).rejects.toBeInstanceOf(LinkedInAuthError);
  });

  it("throws LinkedInRateLimitError on 429", async () => {
    const li = clientWith((url) =>
      url.includes("/feed/") ? mintResponse() : statusResponse(429),
    );
    await expect(li.me()).rejects.toBeInstanceOf(LinkedInRateLimitError);
  });

  it("surfaces a non-CSRF endpoint 403 with its body, without a re-mint storm", async () => {
    let mints = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/feed/")) {
        mints++;
        return mintResponse();
      }
      return statusResponse(403, "Not authorized to view this resource");
    }) as unknown as typeof fetch;
    const li = createLinkedInClient({ liAt: "x", minDelayMs: 0, sleepImpl: async () => {}, fetchImpl });
    await expect(li.memberPosts({ fsdProfileId: "X", limit: 3 })).rejects.toThrow(/Not authorized/);
    expect(mints).toBe(1); // minted once; a non-session 403 must NOT trigger re-mints
  });
});

// ---- discovery parsing ---------------------------------------------------

describe("memberPosts", () => {
  const feed = {
    included: [
      {
        entityUrn: "urn:li:fsd_update:(urn:li:activity:7300000000000000000,MEMBER_SHARES)",
        commentary: { text: { text: "building something with AI agents" } },
        socialDetail: { totalSocialActivityCounts: { numLikes: 42, numComments: "7" } },
      },
      // an entity with no commentary (e.g. an actor/profile) should be ignored
      { entityUrn: "urn:li:fsd_profile:ABC", firstName: "X", lastName: "Y" },
    ],
  };

  it("normalizes posts: id from activity urn, text, counts, url", async () => {
    const li = clientWith((url) => (url.includes("/feed/") ? mintResponse() : jsonResponse(feed)));
    const posts = await li.memberPosts({ fsdProfileId: "ABC123", limit: 5 });
    expect(posts).toHaveLength(1);
    const p = posts[0]!;
    expect(p.id).toBe("7300000000000000000");
    expect(p.urn).toBe("urn:li:activity:7300000000000000000");
    expect(p.text).toContain("AI agents");
    expect(p.reactions).toBe(42);
    expect(p.comments).toBe(7);
    expect(p.url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000000/",
    );
    expect(p.postedAt).toMatch(/^\d{4}-\d\d-\d\dT/); // derived from the id
  });

  it("requests the GraphQL profile-components query for the right profile urn", async () => {
    let voyagerUrl = "";
    const li = clientWith((url) => {
      if (url.includes("/feed/")) return mintResponse();
      voyagerUrl = url;
      return jsonResponse(feed);
    });
    await li.memberPosts({ fsdProfileId: "FSD-XYZ", limit: 3 });
    expect(voyagerUrl).toContain("/voyager/api/graphql");
    expect(voyagerUrl).toContain("queryId=voyagerIdentityDashProfileComponents.");
    expect(voyagerUrl).toContain("sectionType:content-collections");
    expect(decodeURIComponent(voyagerUrl)).toContain("urn:li:fsd_profile:FSD-XYZ");
  });
});

describe("resolveProfile", () => {
  it("resolves a slug to fsdProfileId + name + headline", async () => {
    const data = {
      included: [
        {
          entityUrn: "urn:li:fsd_profile:ACoAA-xyz",
          publicIdentifier: "bosco-maldonado",
          firstName: "Bosco",
          lastName: "Maldonado-Arias",
          headline: "Attention is the new Currency",
        },
      ],
    };
    const li = clientWith((url) => (url.includes("/feed/") ? mintResponse() : jsonResponse(data)));
    const p = await li.resolveProfile("https://www.linkedin.com/in/bosco-maldonado/");
    expect(p?.fsdProfileId).toBe("ACoAA-xyz");
    expect(p?.publicId).toBe("bosco-maldonado");
    expect(p?.name).toBe("Bosco Maldonado-Arias");
    expect(p?.headline).toContain("Currency");
  });
});

// ---- cadence -------------------------------------------------------------

describe("cadence", () => {
  it("throws LinkedInRateLimitError once the per-hour call cap is hit", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/feed/")) return mintResponse();
      return jsonResponse({ data: { "*miniProfile": "urn:li:fs_miniProfile:OK" }, included: [] });
    }) as unknown as typeof fetch;
    const li = createLinkedInClient({
      liAt: "x",
      minDelayMs: 0,
      jitterMs: 0,
      maxCallsPerHour: 2,
      sleepImpl: async () => {},
      nowImpl: () => 1_700_000_000_000,
      fetchImpl,
    });
    await li.me(); // call 1
    await li.me(); // call 2
    await expect(li.me()).rejects.toBeInstanceOf(LinkedInRateLimitError); // over cap
  });
});

// ---- the never-write invariant ------------------------------------------

describe("read-only invariant", () => {
  it("exposes no write/send/comment/connect/message methods", () => {
    const li = clientWith(() => jsonResponse({}));
    const surface = Object.keys(li);
    for (const banned of ["createComment", "comment", "reply", "sendMessage", "dm", "connect", "like", "post", "createPost"]) {
      expect(surface).not.toContain(banned);
    }
    expect(surface.sort()).toEqual(["connections", "me", "memberPosts", "resolveProfile"]);
  });
});

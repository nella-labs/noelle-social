import { describe, expect, it } from "vitest";
import {
  createXApiClient,
  XWriteForbiddenError,
  XDuplicateError,
  XReplyRestrictedError,
  oauth1aHeader,
} from "./apiClient";
import { XAuthError, XRateLimitError, XLockError } from "./index";

const ALLOWED = { role: "x_intern", sendEnabled: true, xApiWriteEnabled: true } as const;

interface Canned {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function fakeFetch(responses: Canned[]) {
  const calls: { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
  let i = 0;
  const fetchFn = (async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[i++] ?? { status: 500, body: {} };
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? r.headers?.[k] ?? null },
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("createXApiClient — the writable-client gate (safety invariant #1)", () => {
  it("throws XWriteForbiddenError for any non-x_intern role", () => {
    for (const role of ["linkedin_intern", "reddit_intern", "video_intern", "ceo", "cmo"]) {
      expect(() =>
        createXApiClient({ tokens: { accessToken: "t" }, role, sendEnabled: true, xApiWriteEnabled: true }),
      ).toThrow(XWriteForbiddenError);
    }
  });

  it("throws when send_enabled or x_api_write_enabled is false", () => {
    expect(() =>
      createXApiClient({ tokens: { accessToken: "t" }, role: "x_intern", sendEnabled: false, xApiWriteEnabled: true }),
    ).toThrow(XWriteForbiddenError);
    expect(() =>
      createXApiClient({ tokens: { accessToken: "t" }, role: "x_intern", sendEnabled: true, xApiWriteEnabled: false }),
    ).toThrow(XWriteForbiddenError);
  });

  it("constructs for an allowed, enabled x_intern", () => {
    expect(() => createXApiClient({ tokens: { accessToken: "t" }, ...ALLOWED })).not.toThrow();
  });
});

describe("postTweet", () => {
  it("posts a top-level tweet and strips external links (no-links chokepoint)", async () => {
    const { fetchFn, calls } = fakeFetch([{ status: 201, body: { data: { id: "123" } } }]);
    const c = createXApiClient({ tokens: { accessToken: "t" }, ...ALLOWED, fetchFn, handle: "vega" });
    const res = await c.postTweet({ text: "shipping fast. see example.com now" });
    expect(res.id).toBe("123");
    expect(res.url).toBe("https://x.com/vega/status/123");
    const body = JSON.parse(calls[0]!.init.body!);
    expect(body.text).toBe("shipping fast. see now");
    expect(body.reply).toBeUndefined();
  });

  it("posts a reply keeping links + in_reply_to_tweet_id", async () => {
    const { fetchFn, calls } = fakeFetch([{ status: 201, body: { data: { id: "456" } } }]);
    const c = createXApiClient({ tokens: { accessToken: "t" }, ...ALLOWED, fetchFn });
    await c.postTweet({ text: "more at example.com", inReplyToId: "999" });
    const body = JSON.parse(calls[0]!.init.body!);
    expect(body.text).toBe("more at example.com");
    expect(body.reply.in_reply_to_tweet_id).toBe("999");
  });

  it("maps 429 to XRateLimitError with a retryAfterMs from x-rate-limit-reset", async () => {
    const reset = Math.floor(Date.now() / 1000) + 30;
    const { fetchFn } = fakeFetch([{ status: 429, headers: { "x-rate-limit-reset": String(reset) }, body: {} }]);
    const c = createXApiClient({ tokens: { accessToken: "t" }, ...ALLOWED, fetchFn });
    await expect(c.postTweet({ text: "hi", inReplyToId: "1" })).rejects.toBeInstanceOf(XRateLimitError);
  });

  it("maps a suspended/automated 403 to XLockError (hard stop)", async () => {
    const { fetchFn } = fakeFetch([{ status: 403, body: { detail: "Your account is suspended and is not permitted." } }]);
    const c = createXApiClient({ tokens: { accessToken: "t" }, ...ALLOWED, fetchFn });
    await expect(c.postTweet({ text: "hi", inReplyToId: "1" })).rejects.toBeInstanceOf(XLockError);
  });

  it("maps duplicate-content 403 to XDuplicateError (non-retryable)", async () => {
    const { fetchFn } = fakeFetch([
      { status: 403, body: { detail: "You are not allowed to create a Tweet with duplicate content." } },
    ]);
    const c = createXApiClient({ tokens: { accessToken: "t" }, ...ALLOWED, fetchFn });
    await expect(c.postTweet({ text: "hi", inReplyToId: "1" })).rejects.toBeInstanceOf(XDuplicateError);
  });

  it("maps a reply-restriction 403 to XReplyRestrictedError (the 2026-07-11 storm error)", async () => {
    const { fetchFn } = fakeFetch([
      {
        status: 403,
        body: {
          detail:
            "Reply to this conversation is not allowed because you have not been mentioned or otherwise engaged.",
        },
      },
    ]);
    const c = createXApiClient({ tokens: { accessToken: "t" }, ...ALLOWED, fetchFn });
    await expect(c.postTweet({ text: "hi", inReplyToId: "1" })).rejects.toBeInstanceOf(XReplyRestrictedError);
  });

  it("maps a who-can-reply restriction 403 to XReplyRestrictedError", async () => {
    const { fetchFn } = fakeFetch([
      { status: 403, body: { detail: "You are not permitted to reply to this conversation." } },
    ]);
    const c = createXApiClient({ tokens: { accessToken: "t" }, ...ALLOWED, fetchFn });
    await expect(c.postTweet({ text: "hi", inReplyToId: "1" })).rejects.toBeInstanceOf(XReplyRestrictedError);
  });

  it("refreshes the token once on 401, then retries and succeeds", async () => {
    const { fetchFn, calls } = fakeFetch([
      { status: 401, body: { title: "Unauthorized" } },
      { status: 200, body: { access_token: "newtok", refresh_token: "newref", expires_in: 7200 } },
      { status: 201, body: { data: { id: "789" } } },
    ]);
    let saved: { accessToken: string } | undefined;
    const c = createXApiClient({
      tokens: { accessToken: "old", refreshToken: "r" },
      clientId: "cid",
      ...ALLOWED,
      fetchFn,
      onTokensRefreshed: (t) => {
        saved = t;
      },
    });
    const res = await c.postTweet({ text: "hi", inReplyToId: "1" });
    expect(res.id).toBe("789");
    expect(saved?.accessToken).toBe("newtok");
    expect(calls).toHaveLength(3);
  });

  it("maps 401 with no refresh token to XAuthError", async () => {
    const { fetchFn } = fakeFetch([{ status: 401, body: {} }]);
    const c = createXApiClient({ tokens: { accessToken: "old" }, ...ALLOWED, fetchFn });
    await expect(c.postTweet({ text: "hi", inReplyToId: "1" })).rejects.toBeInstanceOf(XAuthError);
  });
});

describe("uploadMedia + postTweet with media", () => {
  it("uploads bytes to the v1.1 media endpoint and returns media_id_string", async () => {
    const { fetchFn, calls } = fakeFetch([{ status: 200, body: { media_id_string: "media-42" } }]);
    const c = createXApiClient({ tokens: { accessToken: "t" }, ...ALLOWED, fetchFn });
    const { mediaId } = await c.uploadMedia({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
    expect(mediaId).toBe("media-42");
    expect(calls[0]!.url).toBe("https://upload.twitter.com/1.1/media/upload.json");
    // fetch sets the multipart content-type from FormData — we must not set it by hand.
    expect(calls[0]!.init.headers?.["content-type"]).toBeUndefined();
  });

  it("falls back to numeric media_id when media_id_string is absent", async () => {
    const { fetchFn } = fakeFetch([{ status: 200, body: { media_id: 99 } }]);
    const c = createXApiClient({ tokens: { accessToken: "t" }, ...ALLOWED, fetchFn });
    const { mediaId } = await c.uploadMedia({ bytes: new Uint8Array([9]), mimeType: "image/jpeg" });
    expect(mediaId).toBe("99");
  });

  it("refreshes the token once on a 401 upload, then retries and succeeds", async () => {
    const { fetchFn, calls } = fakeFetch([
      { status: 401, body: {} },
      { status: 200, body: { access_token: "newtok", expires_in: 7200 } },
      { status: 200, body: { media_id_string: "m1" } },
    ]);
    const c = createXApiClient({
      tokens: { accessToken: "old", refreshToken: "r" },
      clientId: "cid",
      ...ALLOWED,
      fetchFn,
    });
    const { mediaId } = await c.uploadMedia({ bytes: new Uint8Array([1]), mimeType: "image/png" });
    expect(mediaId).toBe("m1");
    expect(calls).toHaveLength(3);
  });

  it("maps a media-upload 429 to XRateLimitError", async () => {
    const { fetchFn } = fakeFetch([{ status: 429, body: {} }]);
    const c = createXApiClient({ tokens: { accessToken: "t" }, ...ALLOWED, fetchFn });
    await expect(c.uploadMedia({ bytes: new Uint8Array([1]), mimeType: "image/png" })).rejects.toBeInstanceOf(
      XRateLimitError,
    );
  });

  it("attaches media_ids to a top-level post (capped at 4)", async () => {
    const { fetchFn, calls } = fakeFetch([{ status: 201, body: { data: { id: "9000000000000000001" } } }]);
    const c = createXApiClient({ tokens: { accessToken: "t" }, ...ALLOWED, fetchFn, handle: "vega" });
    const res = await c.postTweet({ text: "ship it", mediaIds: ["a", "b", "c", "d", "e"] });
    expect(res.id).toBe("9000000000000000001");
    const body = JSON.parse(calls[0]!.init.body!);

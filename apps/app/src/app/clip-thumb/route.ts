// Auth-gated image proxy for harvested IG/TikTok clip thumbnails. Their CDN URLs
// hotlink-403 from the browser (referrer/signature checks) and the signatures
// expire, so the <img> tags rendered broken icons. We server-fetch from the
// box's residential IP — the same network Apify harvested them on — and stream
// the bytes back same-origin. Host-allowlisted to the IG/TikTok CDNs so this
// can't be turned into a general-purpose SSRF proxy. Sits behind the app's
// session middleware (single-operator self-host posture).

const ALLOWED_HOST_SUFFIXES = [
  ".cdninstagram.com",
  ".fbcdn.net",
  ".tiktokcdn.com",
  ".tiktokcdn-us.com",
  ".byteimg.com",
  ".ibyteimg.com",
];

export async function GET(req: Request): Promise<Response> {
  const u = new URL(req.url).searchParams.get("u");
  if (!u) return new Response("missing u", { status: 400 });

  let target: URL;
  try {
    target = new URL(u);
  } catch {
    return new Response("bad url", { status: 400 });
  }
  if (target.protocol !== "https:") return new Response("forbidden", { status: 403 });

  const host = target.hostname.toLowerCase();
  if (!ALLOWED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return new Response("forbidden host", { status: 403 });
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok || !upstream.body) return new Response("upstream", { status: 502 });

    const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": contentType,
        // Thumbnails are immutable once fetched and the upstream signature is
        // short-lived anyway — cache hard so we proxy each one at most once.
        "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
      },
    });
  } catch {
    return new Response("fetch failed", { status: 502 });
  }
}

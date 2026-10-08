// Vertex Imagen image generation (GCP-native — "use GCP to its fullest"). Mirrors
// the Vertex auth seam in visionCaption.ts but hits Imagen's :predict endpoint.
// FAIL-OPEN: any failure returns null so the studio never blocks on an image.

export type ImageAuthClient = { getAccessToken(): Promise<string | null | undefined> };

let cachedGoogleAuth: { new (opts: unknown): ImageAuthClient } | undefined;
async function defaultAuthClient(): Promise<ImageAuthClient> {
  if (!cachedGoogleAuth) {
    const mod = await import("google-auth-library");
    cachedGoogleAuth = mod.GoogleAuth as unknown as { new (opts: unknown): ImageAuthClient };
  }
  return new cachedGoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
}

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface GenerateImageOpts {
  project: string;
  location?: string;
  /** Imagen model id. Default imagen-3.0-generate-001. */
  model?: string;
  aspectRatio?: string;
  authClient?: ImageAuthClient;
  fetchImpl?: FetchLike;
}

export interface GenerateImageKeyOpts {
  /** generativelanguage API key (NOELLE_GEMINI_API_KEY). */
  apiKey: string;
  /** Imagen model id on the generativelanguage API. Default imagen-4.0-generate-001. */
  model?: string;
  aspectRatio?: string;
  fetchImpl?: FetchLike;
}

/**
 * Generate ONE image via the generativelanguage **API-key** path (Imagen 4
 * `:predict`). This is the path that WORKS on the Lima self-host box, where the
 * Vertex ADC path (`generateImageVertex`) dies `invalid_rapt` — the same split
 * the teardown analyzers hit. Returns a `data:image/png` URL or null on any
 * failure (fail-open — the studio never blocks on an image).
 */
export async function generateImageGemini(opts: GenerateImageKeyOpts, prompt: string): Promise<string | null> {
  if (!opts.apiKey || !prompt.trim()) return null;
  const model = opts.model ?? "imagen-4.0-generate-001";
  const fetchImpl = (opts.fetchImpl ?? (fetch as unknown as FetchLike));
  try {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${encodeURIComponent(opts.apiKey)}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: opts.aspectRatio ?? "9:16" },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as
      | { predictions?: Array<{ bytesBase64Encoded?: string }> }
      | null;
    const b64 = json?.predictions?.[0]?.bytesBase64Encoded;
    return b64 ? `data:image/png;base64,${b64}` : null;
  } catch {
    return null;
  }
}

/**
 * Generate ONE image from a prompt via Vertex Imagen. Returns a `data:image/png`
 * URL (the base64 the API returns inline) or null on any failure.
 */
export async function generateImageVertex(opts: GenerateImageOpts, prompt: string): Promise<string | null> {
  if (!opts.project || !prompt.trim()) return null;
  const location = opts.location ?? "us-central1";
  const model = opts.model ?? "imagen-3.0-generate-001";
  const fetchImpl = (opts.fetchImpl ?? (fetch as unknown as FetchLike));
  try {
    const auth = opts.authClient ?? (await defaultAuthClient());
    const token = await auth.getAccessToken();
    if (!token) return null;
    const url =
      `https://${location}-aiplatform.googleapis.com/v1/projects/${opts.project}` +
      `/locations/${location}/publishers/google/models/${model}:predict`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: opts.aspectRatio ?? "9:16" },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as
      | { predictions?: Array<{ bytesBase64Encoded?: string }> }
      | null;
    const b64 = json?.predictions?.[0]?.bytesBase64Encoded;
    return b64 ? `data:image/png;base64,${b64}` : null;
  } catch {
    return null;
  }
}

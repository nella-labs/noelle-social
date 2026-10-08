// HMAC-signed content ingestion shared by workers and the CLI.
// Sign the exact serialized JSON body with its Unix timestamp.

import { createHmac } from "node:crypto";
import { PostDraftCreatedSchema, PostIdeasCreatedSchema, ContentMediaWorkerResolveInSchema, parseContentMediaReceipt } from "@noelle/contracts";
import { decodeHttpJson, fetchBoundedHttpResponse } from "./boundedHttp.js";

export interface SignedHeaders {
  timestamp: string;
  signature: string;
}

/** Compute the HMAC headers for a JSON body. `nowSeconds` is unix seconds. */
export function signContentRequest(
  secret: string,
  body: string,
  nowSeconds: number,
): SignedHeaders {
  const timestamp = String(nowSeconds);
  const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  return { timestamp, signature };
}

export type ContentPlatform = "linkedin" | "x" | "reddit";

export interface PushInspirationRef {
  kind: "watchlist_post" | "keyword_post" | "playbook" | "vault";
  leadId?: string;
  url?: string;
  author?: string;
  note?: string;
}

/** One idea card, matching PostIdeaInSchema (camelCase wire shape). */
export interface PushPostIdea {
  id: string;
  /** The idea's home platform (resolves the owning instance). */
  platform: ContentPlatform;
  /** The platforms this idea fans out into (one draft per entry). Absent ⇒ the
   * route defaults to [platform] (single-platform). e.g. ["linkedin","x"]. */
  targetPlatforms?: ContentPlatform[];
  hook: string;
  thesis?: string | null;
  angle?: string | null;
  pillar?: string | null;
  inspirationRefs?: PushInspirationRef[];
  suggestedDay?: string | null;
  batchId?: string | null;
  sourceEngine?: string | null;
  model?: string | null;
}

/** One generated draft, matching PostDraftCreateSchema (camelCase wire shape). */
export interface PushPostDraft {
  ideaId: string;
  platform: ContentPlatform;
  body: string;
  charCount: number;
  sourceEngine?: string | null;
  model?: string | null;
  qualityScore?: number | null;
  qualityPassed?: boolean | null;
  verifierMeta?: unknown | null;
  generationRequestId?: string | null;
}

export interface PushClientOpts {
  /** Base URL of the noelle api-vm (default http://127.0.0.1:18791). */
  apiUrl: string;
  /** NOELLE_HMAC_SECRET (≥32 chars). */
  hmacSecret: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests; defaults to Date.now()/1000. */
  nowSeconds?: number;
  /** Request deadline, including the response body. Default 8 seconds. */
  timeoutMs?: number;
}

async function postSigned(path: string, payload: unknown, opts: PushClientOpts): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);
  const { timestamp, signature } = signContentRequest(opts.hmacSecret, body, now);
  const { response: res, bytes } = await fetchBoundedHttpResponse(`${opts.apiUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-noelle-timestamp": timestamp,
      "x-noelle-signature": signature,
    },
    body,
  }, { fetchImpl, timeoutMs: opts.timeoutMs ?? 8000, maxBytes: 65_536 });
  if (!res.ok) {
    let detail = "";
    try {
      const parsed = decodeHttpJson(bytes) as { error?: unknown } | null;
      if (typeof parsed?.error === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(parsed.error)) detail = parsed.error;
    } catch {
      /* response had no JSON body */
    }
    throw new Error(`content push to ${path} failed: ${res.status} ${detail}`.trim());
  }
  return decodeHttpJson(bytes);
}

/** POST /api/post-ideas (HMAC) — push a batch of idea cards for one platform. */
export async function pushPostIdeas(
  opts: PushClientOpts & { platform: ContentPlatform; ideas: PushPostIdea[] },
): Promise<{ idea_ids: string[] }> {
  const value = await postSigned("/api/post-ideas", { platform: opts.platform, ideas: opts.ideas }, opts);
  try {
    const receipt = PostIdeasCreatedSchema.parse(value);
    const expected = new Set(opts.ideas.map((idea) => idea.id.toLowerCase()));
    const received = receipt.idea_ids.map((id) => id.toLowerCase());
    if (received.length !== opts.ideas.length || new Set(received).size !== expected.size ||
        received.some((id) => !expected.has(id))) throw new Error("invalid idea receipt");
    return receipt;
  } catch {
    throw new Error("content push returned an invalid idea receipt");
  }
}

/** POST /api/post-drafts (HMAC) — push one generated draft for an approved idea. */
export async function pushPostDraft(
  opts: PushClientOpts & { draft: PushPostDraft },
): Promise<{ draft_id: string; idea_id: string }> {
  const value = await postSigned("/api/post-drafts", opts.draft, opts);
  try {
    const receipt = PostDraftCreatedSchema.parse(value);
    if (receipt.idea_id.toLowerCase() !== opts.draft.ideaId.toLowerCase()) throw new Error("invalid idea receipt");
    return receipt;
  } catch {
    throw new Error("content push returned an invalid draft receipt");
  }
}

/** Resolve a bounded org/instance media batch through the existing VM HMAC read surface. */
export async function resolveContentMedia(opts: PushClientOpts & {
  orgId: string; agentInstanceId: string; ids: string[];
}): Promise<Array<{ id: string; url: string | null }>> {
  const input = ContentMediaWorkerResolveInSchema.parse({ orgId: opts.orgId, agentInstanceId: opts.agentInstanceId, ids: opts.ids });
  return parseContentMediaReceipt(await postSigned("/api/content-media/resolve-worker", input,
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 }), input.ids);
}

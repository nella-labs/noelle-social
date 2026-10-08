import { createHmac } from "node:crypto";
import { PostDraftCreateSchema, type PostDraftCreate } from "@noelle/contracts";

// HMAC-signed POST to /api/post-drafts — the post-drafter worker pushes one
// generated post for an approved idea; the api-vm inserts noelle.post_drafts and
// advances the idea to 'drafted'. Mirrors the outbound/post-ideas signing.
export interface PostDraftsClient {
  postDraft(body: PostDraftCreate): Promise<{ draft_id: string; idea_id: string }>;
}

export function createPostDraftsClient(opts: {
  baseUrl: string;
  hmacSecret: string;
  fetchImpl?: typeof fetch;
}): PostDraftsClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async postDraft(body) {
      const parsed = PostDraftCreateSchema.parse(body);
      const json = JSON.stringify(parsed);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = `sha256=${createHmac("sha256", opts.hmacSecret).update(`${ts}.${json}`).digest("hex")}`;
      const res = await fetchImpl(`${opts.baseUrl}/api/post-drafts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-noelle-timestamp": ts,
          "x-noelle-signature": sig,
        },
        body: json,
      });
      if (!res.ok) {
        throw new Error(`POST /api/post-drafts ${res.status}: ${await res.text()}`);
      }
      return (await res.json()) as { draft_id: string; idea_id: string };
    },
  };
}

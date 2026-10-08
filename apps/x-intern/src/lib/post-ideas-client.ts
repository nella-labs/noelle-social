import { createHmac } from "node:crypto";
import { PostIdeasCreateSchema, type PostIdeasCreate } from "@noelle/contracts";

// HMAC-signed POST to /api/post-ideas — the X ideation worker pushes a batch of
// idea cards to the api-vm, which writes noelle.post_ideas. Mirrors the outbound
// client's signing (timestamp + sha256(`${ts}.${json}`)). Byte-identical to the
// LinkedIn intern's copy — the schema already carries platform:"x".
export interface PostIdeasClient {
  postIdeas(body: PostIdeasCreate): Promise<{ idea_ids: string[] }>;
}

export function createPostIdeasClient(opts: {
  baseUrl: string;
  hmacSecret: string;
  fetchImpl?: typeof fetch;
}): PostIdeasClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async postIdeas(body) {
      const parsed = PostIdeasCreateSchema.parse(body);
      const json = JSON.stringify(parsed);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = `sha256=${createHmac("sha256", opts.hmacSecret).update(`${ts}.${json}`).digest("hex")}`;
      const res = await fetchImpl(`${opts.baseUrl}/api/post-ideas`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-noelle-timestamp": ts,
          "x-noelle-signature": sig,
        },
        body: json,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`POST /api/post-ideas ${res.status}: ${text}`);
      }
      return (await res.json()) as { idea_ids: string[] };
    },
  };
}

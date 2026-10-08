// `noelle content push` — the operator/skills side of the content ingestion
// bridge. Reads a JSON payload (idea batch or a generated draft), validates it
// against the wire contract, HMAC-signs it, and POSTs it into the local
// noelle api-vm so it lands in noelle.* and shows up on the dashboard across
// devices — exactly the path the server workers use. This is how a Mac skill
// (voice-post, daily-post-batch, …) gets content into noelle without a
// parallel store.
import { readFile } from "node:fs/promises";
import {
  pushPostIdeas,
  pushPostDraft,
  type ContentPlatform,
  type PushPostIdea,
  type PushPostDraft,
} from "@noelle/runtime/content-push";
import { PostIdeasCreateSchema, PostDraftCreateSchema } from "@noelle/contracts";

export type ContentPushKind = "ideas" | "draft";

export interface ContentPushDeps {
  apiUrl: string;
  hmacSecret: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Read the JSON payload from a file path, or from stdin when none is given. */
export async function readPayload(file?: string): Promise<unknown> {
  const raw = file ? await readFile(file, "utf8") : await readStdin();
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("empty payload — provide --file <path> or pipe JSON on stdin");
  }
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Validate + push a content payload.
 *
 * For `ideas`: the payload is either the full `{ platform, ideas }` object or a
 * bare ideas array (then `platform` is required). `platform` (the flag), when
 * given, overrides the payload's platform.
 * For `draft`: the payload is a single PostDraftCreate object; `platform`
 * overrides its platform when given.
 */
export async function pushContent(opts: {
  kind: ContentPushKind;
  payload: unknown;
  platform?: string;
  deps: ContentPushDeps;
}): Promise<{ kind: ContentPushKind; result: unknown }> {
  const { kind, payload, platform, deps } = opts;

  if (kind === "ideas") {
    const body: Record<string, unknown> = Array.isArray(payload)
      ? { ideas: payload }
      : { ...(payload as Record<string, unknown>) };
    // An explicit --platform overrides BOTH the batch platform AND every
    // idea's platform — the route resolves one owning instance from the batch
    // platform, and the contract requires each idea to match it, so they must
    // move together (without this, --platform produced wrong-instance rows).
    if (platform) {
      body.platform = platform;
      if (Array.isArray(body.ideas)) {
        body.ideas = (body.ideas as Array<Record<string, unknown>>).map((i) => ({
          ...i,
          platform,
        }));
      }
    }
    if (!body.platform) {
      throw new Error("platform is required — set it in the payload or pass --platform");
    }
    const parsed = PostIdeasCreateSchema.parse(body);
    const result = await pushPostIdeas({
      ...deps,
      platform: parsed.platform as ContentPlatform,
      ideas: parsed.ideas as PushPostIdea[],
    });
    return { kind, result };
  }

  // draft
  const draftBody = { ...(payload as Record<string, unknown>) };
  if (platform) draftBody.platform = platform;
  const parsed = PostDraftCreateSchema.parse(draftBody);
  const result = await pushPostDraft({ ...deps, draft: parsed as unknown as PushPostDraft });
  return { kind, result };
}

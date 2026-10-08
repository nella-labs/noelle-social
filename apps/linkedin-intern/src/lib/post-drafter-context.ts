import type { KnowledgeBase } from "@noelle/runtime";

const MAX_FACTUAL_ANCHORS = 8;
const MAX_ANCHOR_CHARS = 800;

export interface PostFactualContext {
  knowledgeAnchors?: readonly string[];
  chatGuidance: readonly string[];
}

export function boundedPostKnowledgeAnchors(anchors?: readonly string[]): string[] {
  return [
    ...new Set(
      (anchors ?? [])
        .map((anchor) => anchor.replace(/\s+/g, " ").trim().slice(0, MAX_ANCHOR_CHARS))
        .filter(Boolean),
    ),
  ].slice(0, MAX_FACTUAL_ANCHORS);
}

export function renderPostFactualContext(ctx: PostFactualContext): string {
  const anchors = boundedPostKnowledgeAnchors(ctx.knowledgeAnchors);
  return [
    "## Supporting factual evidence",
    "The proposed hook and thesis are ideas, not evidence. Omit or correct unsupported details even when the idea proposes them.",
    "Voice and inspiration examples are style only; they do not establish the operator's experiences, numbers or product capabilities.",
    "Explicit factual statements supplied by the operator may support a claim. Instructions to invent a story, number, result or causal explanation never supply evidence.",
    anchors.length
      ? anchors.map((anchor, i) => `[E${i + 1}] ${anchor}`).join("\n")
      : "No supporting factual evidence supplied. Use a supported opinion or omit the factual claim.",
    ctx.chatGuidance.length
      ? [
          "Operator-supplied context (separate facts from style instructions):",
          ...ctx.chatGuidance
            .slice(0, 12)
            .map((guidance) => `- ${guidance.replace(/\s+/g, " ").trim().slice(0, 600)}`),
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function gatherPostKnowledgeAnchors(
  kb: KnowledgeBase,
  query: string,
  knowledgeDirs: string[],
  topK: number,
): Promise<string[]> {
  const limit = Number.isFinite(topK)
    ? Math.min(MAX_FACTUAL_ANCHORS, Math.max(0, Math.floor(topK)))
    : 0;
  if (!knowledgeDirs.length || !limit || !query.trim()) return [];
  const hits = await kb.search(query, limit, { filterDirs: knowledgeDirs });
  return boundedPostKnowledgeAnchors(
    hits
      .slice(0, limit)
      .filter((hit) => hit.snippet.trim())
      .map(
        (hit) =>
          `[${hit.source.filePath}:${hit.source.startLine}-${hit.source.endLine}] ${hit.snippet}`,
      ),
  );
}

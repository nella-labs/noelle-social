import { createGeminiKeyBackend } from "./geminiKeyBackend.js";
import { createVertexBackend } from "./vertexBackend.js";
import type { EngineBackend } from "./callAgentModel.js";

/**
 * Use the supplied Gemini key, otherwise Vertex with ADC authentication.
 * Abstract model names are mapped by the selected backend. The generation
 * deadline covers its full HTTP response; ADC lookup remains separate.
 */
export function selectGeminiBackend(opts: {
  apiKey: string | undefined;
  gcpProject: string;
  timeoutMs?: number;
}): EngineBackend {
  if (opts.apiKey) {
    return createGeminiKeyBackend({
      apiKey: opts.apiKey,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }
  return createVertexBackend({ project: opts.gcpProject,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
}

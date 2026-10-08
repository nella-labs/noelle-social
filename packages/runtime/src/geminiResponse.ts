import type { TokenUsage } from "./callAgentModel.js";
import { normalizeTokenUsage } from "./callCostAccounting.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Decode generated text and distinguish absent token metadata from reported zero. */
export function parseGeminiGeneration(value: unknown, separator = ""): { text: string; usage: TokenUsage } {
  const response = object(value);
  const candidates = response?.candidates;
  const candidate = Array.isArray(candidates) ? object(candidates[0]) : undefined;
  const parts = object(candidate?.content)?.parts;
  if (!Array.isArray(parts)) throw new Error("Gemini response contains no valid generated text");
  const textParts: string[] = [];
  for (const value of parts) {
    const part = object(value);
    if (!part || (part.text !== undefined && typeof part.text !== "string")) {
      throw new Error("Gemini response contains invalid generated text");
    }
    if (typeof part.text === "string" && part.thought !== true) textParts.push(part.text);
  }
  const text = textParts.join(separator);
  if (!text.trim()) throw new Error("Gemini response contains no valid generated text");
  const metadata = object(response?.usageMetadata);
  const input = metadata?.promptTokenCount;
  const output = metadata?.candidatesTokenCount;
  return { text, usage: normalizeTokenUsage(input, output) };
}

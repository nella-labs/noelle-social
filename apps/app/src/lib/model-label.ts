/**
 * Map a raw model id (from `noelle.llm_calls.model`, an agent's
 * `model_overrides`, etc.) to a clean, user-safe display name.
 *
 * HARD RULE: the product never shows the LLM backend/runtime to users
 * (no "bedrock", "vertex", "codex", "aws", "gcp") and never the "gpt-5"
 * string. This returns only a friendly model name for the models Noelle
 * openly offers (Claude, Gemini), and `null` for anything else — callers
 * render nothing rather than leak a backend or an un-offered model.
 */

const MODEL_NAMES: Record<string, string> = {
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-7": "Opus 4.7",
  "gemini-2-5-flash": "Gemini 2.5 Flash",
  "gemini-2-5-pro": "Gemini 2.5 Pro",
};

/**
 * Strip any LLM backend/runtime token from a free-text string before it's
 * shown to users. Worker error messages start with the backend name (e.g.
 * "vertex 503: model unavailable", "bedrock auth: expired", "codex oauth
 * expired"), and those flow verbatim into the Recent-activity feed. We keep
 * the useful remainder of the error but never the backend name.
 */
const BACKEND_TOKEN = /\b(?:bedrock|vertex|codex|aws|gcp|gpt-?5)\b[:\s]*/gi;

export function scrubBackendTokens(text: string | null | undefined): string {
  if (!text) return "";
  return String(text).replace(BACKEND_TOKEN, "").replace(/\s{2,}/g, " ").trim();
}

export function cleanModelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  // Defensively strip any leading "engine · " / "engine/" the data layer
  // might still carry — the engine is NEVER surfaced to users.
  const raw = String(model);
  const id = (raw.includes(" · ")
    ? raw.slice(raw.lastIndexOf(" · ") + 3)
    : raw.includes("/")
      ? raw.slice(raw.lastIndexOf("/") + 1)
      : raw
  )
    .trim()
    .toLowerCase();

  if (MODEL_NAMES[id]) return MODEL_NAMES[id];
  // Family fallback for unknown versions — keep the Claude/Gemini name,
  // hide everything else (gpt-5, codex, unknown).
  if (id.startsWith("claude-sonnet")) return "Sonnet";
  if (id.startsWith("claude-opus")) return "Opus";
  if (id.startsWith("claude-haiku")) return "Haiku";
  if (id.startsWith("gemini")) return "Gemini";
  return null;
}

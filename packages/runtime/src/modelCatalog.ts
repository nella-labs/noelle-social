/**
 * Single source of truth for the models Noelle exposes to operators.
 *
 * The dashboard's per-worker model picker reads from `MODEL_CATALOG`; the
 * runtime resolver maps a `{engine, model}` pair back to a backend through
 * `callAgentModel`. Adding a model in one place wires it everywhere.
 *
 * `status` distinguishes "wired and billable today" (ready) from "we plan
 * to add this backend; users can pick it but the resolver falls back until
 * the backend lands" (preview). Vertex Gemini ships ready (the new
 * `vertexBackend.ts` calls aiplatform.googleapis.com against noelle-agents
 * so traffic burns the GenAI App Builder trial credit); Vertex Claude and
 * the Anthropic-direct family stay preview until those backends land.
 * The picker still lists preview entries so operators see what's coming.
 * When the backend lands, flip `status` to "ready" without touching the UI.
 *
 * Keep `engine` aligned with `EngineHandle` (./types.ts) and the
 * `llmPrices.ts` table — `estimateCallCents` throws on unknown handles so
 * a worker can never route to an un-billable engine silently.
 */

import type { EngineHandle } from "./types.js";

export type CatalogStatus = "ready" | "preview";

/**
 * One row of the picker. `family` groups Bedrock vs Vertex vs Anthropic in
 * the UI; `tags` drive capability hints (good-for-classification,
 * good-for-drafting). `recommendedFor` lets the config page pre-fill
 * sensible defaults for new instances (drafter → sonnet, classifier →
 * haiku/flash, etc.).
 */
export interface CatalogEntry {
  engine: EngineHandle["engine"];
  model: string;
  label: string;
  /** Short hint shown under the radio. */
  hint: string;
  family: "bedrock" | "vertex" | "anthropic" | "openai";
  status: CatalogStatus;
  /** Cents per million input tokens. Mirrors llmPrices.ts for UI display. */
  inputCentsPerMTok: number;
  outputCentsPerMTok: number;
  /** Loose capability tags, used by the picker for "recommended for X" chips. */
  tags: Array<"draft" | "classify" | "chat" | "cheap" | "premium">;
  /** Workers this model is a reasonable default for, if any. */
  recommendedFor?: Array<"classifier" | "drafter">;
}

export const MODEL_CATALOG: CatalogEntry[] = [
  // ── Bedrock (production-wired) ─────────────────────────────────────────
  {
    engine: "bedrock",
    model: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    hint: "Cheapest Claude — good fit for classifiers and pre-screens.",
    family: "bedrock",
    status: "ready",
    inputCentsPerMTok: 80,
    outputCentsPerMTok: 400,
    tags: ["classify", "cheap"],
    recommendedFor: ["classifier"],
  },
  {
    engine: "bedrock",
    model: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    hint: "Default drafter model — fast, on-brand, cheap enough for batch.",
    family: "bedrock",
    status: "ready",
    inputCentsPerMTok: 300,
    outputCentsPerMTok: 1500,
    tags: ["draft", "chat"],
    recommendedFor: ["drafter"],
  },
  {
    engine: "bedrock",
    model: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    hint: "Highest quality we can call — ~5× drafter cost. Reserve for escalations.",
    family: "bedrock",
    status: "ready",
    inputCentsPerMTok: 1500,
    outputCentsPerMTok: 7500,
    tags: ["draft", "premium"],
  },

  // ── Vertex AI ──────────────────────────────────────────────────────────
  // Gemini is fully wired via `vertexBackend.ts` and bills against
  // noelle-agents (covered by the GenAI App Builder trial credit).
  // Claude-on-Vertex stays preview — we don't ship a wrapper for it; the
  // Anthropic SDK is the only path to Claude today.
  {
    engine: "vertex",
    model: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    hint: "Preview — currently runs on our default managed model.",
    family: "vertex",
    status: "preview",
    inputCentsPerMTok: 300,
    outputCentsPerMTok: 1500,
    tags: ["draft"],
  },
  {
    engine: "vertex",
    model: "gemini-2-5-flash",
    label: "Gemini 2.5 Flash",
    hint: "Cheapest Gemini — great for classifiers and pre-screens.",
    family: "vertex",
    status: "ready",
    inputCentsPerMTok: 15,
    outputCentsPerMTok: 60,
    tags: ["classify", "cheap"],
    recommendedFor: ["classifier"],
  },
  {
    engine: "vertex",
    model: "gemini-2-5-pro",
    label: "Gemini 2.5 Pro",
    hint: "Fast, on-brand — a solid default drafter.",
    family: "vertex",
    status: "ready",
    inputCentsPerMTok: 125,
    outputCentsPerMTok: 500,
    tags: ["draft", "chat"],
    recommendedFor: ["drafter"],
  },

  // ── Anthropic direct (wired via anthropicBackend.ts) ───────────────────
  // Ready when an ANTHROPIC_API_KEY is configured (self-host BYOK, or the
  // managed box if a key is provisioned). On a deployment with no Anthropic
  // key wired into the engine registry, callAgentModel falls back to the
  // routing fallback for these handles.
  {
    engine: "claude",
    model: "claude-haiku-4-5",
    label: "Claude Haiku 4.5 (Anthropic direct)",
    hint: "Direct Anthropic API — billed against your key. Cheapest Claude.",
    family: "anthropic",
    status: "ready",
    inputCentsPerMTok: 80,
    outputCentsPerMTok: 400,
    tags: ["classify", "cheap"],
  },
  {
    engine: "claude",
    model: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6 (Anthropic direct)",
    hint: "Direct Anthropic API — billed against your key.",
    family: "anthropic",
    status: "ready",
    inputCentsPerMTok: 300,
    outputCentsPerMTok: 1500,
    tags: ["draft", "chat"],
  },
  {
    engine: "claude",
    model: "claude-opus-4-6",
    label: "Claude Opus 4.6 (Anthropic direct)",
    hint: "Highest quality via Anthropic's first-party API. Billed against your key.",
    family: "anthropic",
    status: "ready",
    inputCentsPerMTok: 1500,
    outputCentsPerMTok: 7500,
    tags: ["draft", "premium"],
  },

  // ── OpenAI direct (wired via openaiBackend.ts) ─────────────────────────
  // Ready when an OPENAI_API_KEY is configured (bring-your-own key).
  {
    engine: "openai",
    model: "gpt-5-mini",
    label: "GPT-5 mini (OpenAI direct)",
    hint: "Direct OpenAI API — cheap, good for classifiers and pre-screens.",
    family: "openai",
    status: "ready",
    inputCentsPerMTok: 25,
    outputCentsPerMTok: 200,
    tags: ["classify", "cheap"],
  },
  {
    engine: "openai",
    model: "gpt-5",
    label: "GPT-5 (OpenAI direct)",
    hint: "Direct OpenAI API — strong general drafter. Billed against your key.",
    family: "openai",
    status: "ready",
    inputCentsPerMTok: 125,
    outputCentsPerMTok: 1000,
    tags: ["draft", "chat"],
    recommendedFor: ["drafter"],
  },
];

/** Find a catalog entry by its `(engine, model)` pair. */
export function lookupCatalogEntry(
  engine: EngineHandle["engine"] | string,
  model: string,
): CatalogEntry | undefined {
  return MODEL_CATALOG.find((m) => m.engine === engine && m.model === model);

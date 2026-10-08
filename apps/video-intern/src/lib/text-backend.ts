import { createClaudeCliBackend, createBedrockBackend, CLAUDE_CLI_MODEL, type EngineKey } from "@noelle/runtime";
import { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY } from "@noelle/runtime/pg-budget-adapters";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import type { Sql } from "postgres";
import type { Env } from "../env.js";
import { createBackendJsonFn, createVertexJsonFn, type JsonFn } from "./video-generate.js";
import type { VideoModelMetering } from "./video-gemini.js";

// Configured text resource for ideation, scripting, briefing and objective grading.
// Routing precedence: local Claude subscription, configured AWS keys, then Gemini.
// Every engine uses canonical admission and received-usage accounting.
// Ordinary failures return null; canonical admission failures propagate.

export type TextEngine = "claude" | "bedrock" | "vertex";

export interface TextJsonCaller {
  forInstance(instance: { id: string; org_id: string }): JsonFn;
  /** Stamped onto generated rows' source_engine for provenance. */
  engine: TextEngine;
  /** Configured model label stamped alongside the artifact. */
  model: string;
}

const BEDROCK_REGION = process.env.NOELLE_VIDEO_BEDROCK_REGION?.trim() || "us-east-1";

/** Pool resources are shared; each binding captures its own immutable attribution values. */
export function createVideoModelMetering(sql: Sql, worker: string) {
  const budget = { adapters: createPgBudgetAdapters(sql, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY }) };
  const recorder = createPgSpendRecorder(sql);
  return (instance: { id: string; org_id: string }, engine: EngineKey): VideoModelMetering => ({
    engine, context: { orgId: instance.org_id, instanceId: instance.id, agentRole: "video_intern", worker, bucket: "drafter" },
    budget, recorder,
  });
}

export function createTextJsonFn(env: Env, resources: { sql: Sql; worker: string }): TextJsonCaller {
  const bedrockModel = env.NOELLE_VIDEO_TEXT_MODEL;
  const scope = createVideoModelMetering(resources.sql, resources.worker);

  if (env.NOELLE_CLAUDE_CLI === "1") {
    // claude-cli ignores the per-call model and always runs the strongest local
    // subscription model; stamp the backend's own constant so provenance can
    // never drift from what actually ran.
    const model = CLAUDE_CLI_MODEL;
    const backend = createClaudeCliBackend();
    return { forInstance: instance => createBackendJsonFn(backend, model, { metering: scope(instance, "claude-cli") }), engine: "claude", model };
  }

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) {
    const backend = createBedrockBackend({ region: BEDROCK_REGION, accessKeyId, secretAccessKey, maxTokens: 2048 });
    return { forInstance: instance => createBackendJsonFn(backend, bedrockModel, { metering: scope(instance, "bedrock") }), engine: "bedrock", model: bedrockModel };
  }

  // No local Claude or AWS credentials: use the configured Gemini key or ADC.
  const opts = { apiKey: env.NOELLE_GEMINI_API_KEY, project: env.GCP_PROJECT, location: env.VERTEX_LOCATION };
  return {
    forInstance: instance => createVertexJsonFn({ ...opts, metering: scope(instance, "vertex") }),
    engine: "vertex",
    model: "gemini-2.5-flash",
  };
}

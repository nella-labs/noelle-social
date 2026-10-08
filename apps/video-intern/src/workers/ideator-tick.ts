import type { Sql } from "postgres";
import { randomUUID } from "node:crypto";
import { VideoIdeationRequestSchema } from "@noelle/contracts";
import type { Logger } from "../lib/logger.js";
import type { PendingIdeationInstance } from "../lib/video-ideas-db.js";
import { insertVideoIdeas } from "../lib/video-ideas-db.js";
import { loadUltraProfiles, loadTopClips } from "../lib/brand-guide-db.js";
import type { VideoIdeator } from "../lib/video-generate.js";
import { loadBrandContext, type VaultKb } from "../lib/vault-grounding.js";

export interface IdeatorTickDeps {
  sql: Sql;
  log: Logger;
  instance: PendingIdeationInstance;
  ideator: VideoIdeator;
  model: string;
  /** Provenance stamp for the generated rows (claude | bedrock | vertex). */
  sourceEngine?: string;
  /** Vault KB for brand/voice grounding (null = no vault → skipped). */
  kb?: VaultKb | null;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function nextMonday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const delta = day === 1 ? 7 : (8 - day) % 7 || 7;
  return addDays(d, delta);
}

/**
 * W4 ideation (Muse). Reads the instance's pending video_ideation_request, loads
 * the Brand Guide + top clips, and generates idea cards via Vertex. Batch mode
 * assigns Mon–Sun suggested_day. Returns ideas inserted. The entry clears the
 * request flag in `finally`.
 */
export async function runIdeatorTick(deps: IdeatorTickDeps): Promise<number> {
  const { sql, log, instance, ideator } = deps;
  const req = VideoIdeationRequestSchema.parse((instance.video_ideation_request ?? {}) as object);
  const profiles = await loadUltraProfiles(sql, instance.id, 12);
  const clips = await loadTopClips(sql, instance.id, 16);
  const count = req.mode === "batch" ? 7 : req.count;
  const brandContext = await loadBrandContext(deps.kb ?? null, instance.objective);
  const out = await ideator.ideate({ objective: instance.objective, count, profiles, clips, brandContext });
  if (!out || out.ideas.length === 0) {
    log.warn({ instance: instance.id }, "ideator returned no ideas");
    return 0;
  }
  let ideas = out.ideas;
  let batchId: string | null = null;
  if (req.mode === "batch") {
    batchId = randomUUID();
    const start = req.weekStart ? new Date(`${req.weekStart}T00:00:00Z`) : nextMonday();
    ideas = ideas.slice(0, 7).map((idea, i) => ({ ...idea, suggestedDay: isoDay(addDays(start, i)) }));
  }
  const n = await insertVideoIdeas(sql, {
    orgId: instance.org_id,
    instanceId: instance.id,
    platform: "instagram",
    ideas,
    batchId,
    sourceEngine: deps.sourceEngine ?? "vertex",
    model: deps.model,
  });
  log.info({ instance: instance.id, mode: req.mode, ideas: n }, "ideas generated");
  return n;
}

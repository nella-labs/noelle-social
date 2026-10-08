import type { Sql } from "postgres";
import { voyageEmbed } from "@noelle/runtime";
import type { ActiveInstance } from "../lib/activation.js";
import type { Logger } from "../lib/logger.js";
import { distillUltraProfile } from "../lib/distill.js";
import {
  listDistillationSubjects,
  listTeardownsForSubject,
  upsertUltraProfile,
  listUnembeddedClips,
  writeClipEmbeddings,
} from "../lib/ultra-profiles-db.js";
import { buildPersonalBrandState, writePersonalBrandState } from "../lib/personal-brand-state.js";
import type { VaultKb } from "../lib/vault-grounding.js";

/** Config for the flag-gated personal-brand-state regeneration (default OFF). */
export interface PersonalBrandStateConfig {
  /** NOELLE_PERSONAL_BRAND_STATE — master gate. Off → never generate. */
  enabled: boolean;
  /** Absolute path to write the artifact to; null → nowhere to write → no-op. */
  statePath: string | null;
  /** Vault KB for the brand/voice "How I sound" snippets (null → omitted). */
  kb: VaultKb | null;
}

export interface DistillerTickDeps {
  sql: Sql;
  log: Logger;
  instance: ActiveInstance;
  voyageApiKey?: string;
  embedLimit: number;
  /** When present + enabled, regenerate personal-brand-state.md after distillation. */
  personalBrandState?: PersonalBrandStateConfig;
}

/**
 * W3 Distill — roll each handle's teardowns up into a Video Brand Guide
 * (video_ultra_profiles) via the deterministic distiller, then Voyage-embed the
 * instance's un-embedded clips so the studio can retrieve exemplars by semantic
 * fit. Declared OWN handles are aggregated once per platform as scope='account' (subject='me')
 * so ideation can lean on what the operator's own content does; everyone else is
 * a watched creator. Fail-open.
 */
export async function runDistillerTick(deps: DistillerTickDeps): Promise<{ profiles: number; embedded: number }> {
  const { sql, log, instance } = deps;
  let profiles = 0;
  for (const target of await listDistillationSubjects(sql, instance.id)) {
    const items = await listTeardownsForSubject(sql, instance.id, target);
    if (!items.length) continue;
    await upsertUltraProfile(sql, {
      orgId: instance.org_id,
      instanceId: instance.id,
      platform: target.platform,
      scope: target.scope,
      subject: target.subject,
      distilled: distillUltraProfile(items),
      model: "heuristic-v1",
    });
    profiles += 1;
  }

  // Regenerate the operator's personal-brand-state.md from the freshly-upserted
  // account profile + self metrics + brand-doc snippets, so the scripter can prefer
  // it. Flag-gated and fully fail-open: any error is logged and swallowed so this
  // can never block the distiller's core work (profiles + embeddings).
  const pbs = deps.personalBrandState;
  if (pbs?.enabled && pbs.statePath) {
    try {
      const md = await buildPersonalBrandState({
        sql,
        instanceId: instance.id,
        objective: instance.objective,
        kb: pbs.kb,
        generatedAt: new Date(),
      });
      await writePersonalBrandState(pbs.statePath, md);
      log.info({ instance: instance.id, path: pbs.statePath }, "personal-brand-state regenerated");
    } catch (err) {
      log.warn(
        { err: (err as Error).message, instance: instance.id },
        "personal-brand-state generation failed (ignored)",
      );
    }
  }

  let embedded = 0;
  if (deps.voyageApiKey) {
    const clips = await listUnembeddedClips(sql, instance.id, deps.embedLimit);
    if (clips.length) {
      const vecs = await voyageEmbed(
        clips.map((c) => c.text),
        { apiKey: deps.voyageApiKey, inputType: "document" },
      ).catch(() => [] as number[][]);
      const rows = clips.flatMap((c, i) => (vecs[i] ? [{ id: c.id, embedding: vecs[i]! }] : []));
      await writeClipEmbeddings(sql, rows);
      embedded = rows.length;
    }
  }

  log.info({ instance: instance.id, profiles, embedded }, "distill complete");
  return { profiles, embedded };
}

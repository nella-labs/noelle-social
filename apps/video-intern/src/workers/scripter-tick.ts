import type { Sql } from "postgres";
import { isBudgetAdmissionError, voyageEmbed } from "@noelle/runtime";
import type { ActiveInstance } from "../lib/activation.js";
import type { Logger } from "../lib/logger.js";
import {
  claimApprovedIdeas,
  markIdeaDrafted,
  revertIdeaToApproved,
  setIdeaInspirationClips,
} from "../lib/video-ideas-db.js";
import { loadUltraProfiles, loadExemplarClips, selectVideoExemplars, type ClipBrief } from "../lib/brand-guide-db.js";
import { insertVideoDraft } from "../lib/video-drafts-db.js";
import type { VideoScripter, JsonFn } from "../lib/video-generate.js";
import { loadBrandContextPreferringState, type VaultKb } from "../lib/vault-grounding.js";
import { verifyScript, verdictScore, type ScriptVerdict } from "../lib/script-verify.js";
import { loadActivePatternRules } from "../lib/pattern-breaker-db.js";
import type { VideoScriptOutput } from "@noelle/contracts";
import type { DynamicPattern } from "@noelle/runtime";

export interface ScripterVerifyConfig {
  enabled: boolean;
  /** Max regenerations after the first attempt (NOELLE_DRAFTER_VERIFY_RETRIES). */
  retries: number;
  /** Voice score below which a draft is "below bar" (NOELLE_DRAFTER_VOICE_FLOOR). */
  voiceFloor: number;
}

export interface ScripterTickDeps {
  sql: Sql;
  log: Logger;
  instance: ActiveInstance;
  scripter: VideoScripter;
  batchLimit: number;
  model: string;
  /** Provenance stamp for the generated drafts (claude | bedrock | vertex). */
  sourceEngine?: string;
  /** Vault KB for brand/voice grounding (null = no vault → skipped). */
  kb?: VaultKb | null;
  /**
   * Absolute path of the generated personal-brand-state.md. When set and the file
   * exists, its distilled anchors lead the brand context ahead of the BM25 hits;
   * null/absent/unreadable → base BM25 context unchanged (fail-open). Off by default
   * (NOELLE_PERSONAL_BRAND_STATE); resolved via resolvePersonalBrandStatePath.
   */
  statePath?: string | null;
  /** Voyage key for semantic exemplar selection (absent → views-ordered fallback). */
  voyageApiKey?: string;
  /** Post-draft verifier config + judge backend (off → drafts written unverified). */
  verify?: ScripterVerifyConfig;
  verifyJson?: JsonFn;
}

export class ScripterOutcomeError extends Error {
  constructor(cause: Error, readonly rowsProcessed: number) {
    super(cause.message, { cause });
    this.name = "ScripterOutcomeError";
  }
}

/**
 * Semantic exemplars for an idea: embed the hook+concept and cosine-rank the
 * instance's clip corpus (voyage-3-large vectors backfilled by the distiller).
 * Fail-open to the views-ordered `loadExemplarClips` when there's no Voyage key,
 * no embedded clip yet, or an embed error — so behaviour never regresses.
 * Returns the clips + whether the semantic lane actually produced them.
 */
async function pickExemplars(
  deps: ScripterTickDeps,
  idea: { id: string; hook: string; concept: string | null; inspiration_clip_ids: string[] },
): Promise<{ exemplars: ClipBrief[]; semantic: boolean }> {
  const { sql, instance } = deps;
  if (deps.voyageApiKey) {
    const query = `${idea.hook}\n${idea.concept ?? ""}`.trim();
    if (query) {
      const vecs = await voyageEmbed([query], { apiKey: deps.voyageApiKey, inputType: "query" }).catch(
        () => [] as number[][],
      );
      const vec = vecs[0];
      if (vec?.length) {
        const semantic = await selectVideoExemplars(sql, instance.id, vec, 6);
        if (semantic.length) return { exemplars: semantic, semantic: true };
      }
    }
  }
  return { exemplars: await loadExemplarClips(sql, instance.id, idea.inspiration_clip_ids ?? [], 6), semantic: false };
}

/**
 * W4 scripting (Blueprint + Scribe). Claims approved video_ideas, retrieves the
 * idea's exemplar clips (semantic when embeddings exist) + the Brand Guide,
 * generates a timed structure + script + asset suggestions, VERIFIES it (voice /
 * grounding / relevance / format) and regenerates below the bar, then writes a
 * video_draft with the verifier trace. Ordinary failures revert the idea to
 * 'approved' and continue. Denied admission releases unstarted ideas and stops
 * the batch with the count of drafts already written.
 */
export async function runScripterTick(deps: ScripterTickDeps): Promise<number> {
  const { sql, log, instance, scripter } = deps;
  // Verify the complete standing-rule set before claiming ideas or calling any provider.
  const patternRules: DynamicPattern[] = await loadActivePatternRules(sql, {
    orgId: instance.org_id,
    agentInstanceId: instance.id,
    role: "video_intern",
  });
  const claimed = await claimApprovedIdeas(sql, instance.id, deps.batchLimit);
  if (claimed.length === 0) return 0;
  const profiles = await loadUltraProfiles(sql, instance.id, 8);
  const verifyOn = Boolean(deps.verify?.enabled && deps.verifyJson);
  const maxAttempts = verifyOn ? (deps.verify?.retries ?? 0) + 1 : 1;
  let n = 0;
  for (const [index, idea] of claimed.entries()) {
    try {
      const { exemplars, semantic } = await pickExemplars(deps, idea);
      const brandContext = await loadBrandContextPreferringState(
        deps.kb ?? null,
        idea.hook || instance.objective,
        deps.statePath ?? null,
      );

      // Generate → verify → regenerate-with-critique, keeping the best attempt.
      let best: { out: VideoScriptOutput; verdict: ScriptVerdict | null } | null = null;
      let critique: string | null = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const cand = await scripter.script({
          hook: idea.hook,
          concept: idea.concept,
          objective: instance.objective,
          profiles,
          exemplars,
          brandContext,
          critique,
          patternRules,
        });
        if (!cand) continue;
        if (!verifyOn) {
          best = { out: cand, verdict: null };
          break;
        }
        const v = await verifyScript(
          cand,
          { objective: instance.objective, hook: idea.hook, concept: idea.concept, voiceAnchors: brandContext, patternRules },
          deps.verifyJson!,
          { voiceFloor: deps.verify!.voiceFloor },
        );
        const verdict: ScriptVerdict = { ...v, attempts: attempt };
        if (!best || best.verdict == null || verdictScore(verdict) > verdictScore(best.verdict)) {
          best = { out: cand, verdict };
        }
        if (verdict.pass) break;
        critique = verdict.fix;
        log.info({ idea: idea.id, attempt, scores: verdict.scores }, "script below bar; regenerating");
      }

      if (!best) {
        log.warn({ idea: idea.id }, "scripter returned null; reverting to approved for retry");
        await revertIdeaToApproved(sql, idea.id);
        continue;
      }

      // Persist the clips the script was actually built from, so the studio's
      // "Inspired by" strip reflects real provenance (only when semantic ran).
      if (semantic) await setIdeaInspirationClips(sql, idea.id, exemplars.map((e) => e.id)).catch(() => {});

      const verdict = best.verdict;
      await insertVideoDraft(sql, {
        orgId: instance.org_id,
        instanceId: instance.id,
        ideaId: idea.id,
        platform: idea.platform,
        out: best.out,
        sourceEngine: deps.sourceEngine ?? "vertex",
        model: deps.model,
        qualityPassed: verdict ? verdict.pass : null,
        verifierMeta: verdict
          ? { pass: verdict.pass, scores: verdict.scores, reasons: verdict.reasons, attempts: verdict.attempts }
          : null,
      });
      await markIdeaDrafted(sql, idea.id);
      n++;
      log.info(
        { idea: idea.id, beats: best.out.structure.length, semantic, verified: verifyOn, passed: verdict?.pass ?? null },
        "draft scripted",
      );
    } catch (err) {
      log.error({ err: (err as Error).message, idea: idea.id }, "scripter idea failed");
      if (isBudgetAdmissionError(err)) {
        for (const unstarted of claimed.slice(index)) {
          try { await revertIdeaToApproved(sql, unstarted.id); }
          catch { log.warn({ idea: unstarted.id }, "unstarted script release could not be recorded"); }
        }
        throw new ScripterOutcomeError(err, n);
      }
      await revertIdeaToApproved(sql, idea.id).catch(() => {});
    }
  }
  return n;
}

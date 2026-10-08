import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Sql } from "postgres";
import { VideoUltraProfileSchema } from "@noelle/contracts";
import { loadUltraProfiles } from "./brand-guide-db.js";
import { renderSkillMarkdown } from "./skill-render.js";
import type { Logger } from "./logger.js";
import { readSourceNonnegativeNumber } from "@noelle/runtime/source-values";

// W3b Skiller — read the distilled Video Brand Guides (video_ultra_profiles) and
// write one SKILL.md per profile into the operator vault, so each viral pattern
// becomes a reusable skill file. The distiller produced the rows; this just
// projects them onto disk. Fail-open PER ROW: one bad profile (schema miss or a
// write error) is logged and skipped, never aborting the rest of the batch.

// The knowledge-base env keys the resolver reads. A structural subset so the
// resolver accepts BOTH `process.env` and the worker's parsed `Env` object.
type SkillsDirEnv = {
  NOELLE_VIDEO_SKILLS_DIR?: string | undefined;
  NOELLE_VAULT_DIR?: string | undefined;
};

/**
 * Where the skiller writes. Explicit NOELLE_VIDEO_SKILLS_DIR wins; otherwise
 * <NOELLE_VAULT_DIR>/skills/video-patterns. Null when neither is set — the
 * worker then no-ops (mirrors voiceSpecPath / videoSkillsDir-less self-hosts).
 */
export function videoSkillsDir(env: SkillsDirEnv = process.env): string | null {
  const explicit = env.NOELLE_VIDEO_SKILLS_DIR?.trim();
  if (explicit) return explicit;
  const vault = env.NOELLE_VAULT_DIR?.trim();
  return vault ? join(vault, "skills/video-patterns") : null;
}

// A <slug>/SKILL.md relative path is safe only if it stays inside <dir>. The slug
// we generate is already `[a-z0-9-]+`, but guard defensively (mirrors
// isSafeVaultPath) so a future slug change can never escape the skills dir.
function isSafeSkillRel(rel: string): boolean {
  if (!rel || rel.startsWith("/") || rel.includes("..") || rel.includes("\0")) return false;
  return rel.toLowerCase().endsWith(".md");
}

// timestamptz comes back as a Date (postgres default); tolerate a string too.
function toISO(v: Date | string | null | undefined): string {
  if (!v) return "";
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export interface EmitSkillFilesArgs {
  sql: Sql;
  instanceId: string;
  /** Absolute skills dir (from videoSkillsDir). */
  dir: string;
  log: Logger;
  /** How many Brand Guides to project this pass. */
  limit?: number;
}

export async function emitSkillFiles(
  args: EmitSkillFilesArgs,
): Promise<{ written: number; paths: string[] }> {
  const { sql, instanceId, dir, log } = args;
  const rows = await loadUltraProfiles(sql, instanceId, args.limit ?? 12);
  const paths: string[] = [];

  for (const row of rows) {
    try {
      const parsed = VideoUltraProfileSchema.safeParse(row.profile);
      if (!parsed.success) {
        log.warn(
          { instance: instanceId, scope: row.scope, subject: row.subject },
          "skiller: profile failed schema; skipping",
        );
        continue;
      }

      const { slug, markdown } = renderSkillMarkdown({
        platform: row.platform,
        scope: row.scope,
        subject: row.subject,
        profile: parsed.data,
        avgViews: readSourceNonnegativeNumber(row.avg_views),
        clipsAnalyzed: row.clips_analyzed,
        refreshedAtISO: toISO(row.refreshed_at),
      });

      const rel = join(slug, "SKILL.md");
      if (!isSafeSkillRel(rel)) {
        log.warn({ instance: instanceId, slug }, "skiller: unsafe skill path; skipping");
        continue;
      }
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, markdown, "utf8");
      paths.push(abs);
    } catch (err) {
      // Fail-open: one row's failure never sinks the batch.
      log.warn(
        { instance: instanceId, subject: row.subject, err: (err as Error).message },
        "skiller: failed to emit skill; skipping",
      );
    }
  }

  return { written: paths.length, paths };
}

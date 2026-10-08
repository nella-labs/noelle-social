import type { Sql } from "postgres";
import type { ActiveInstance } from "../lib/activation.js";
import type { Logger } from "../lib/logger.js";
import { emitSkillFiles } from "../lib/skill-emit.js";

export interface SkillerTickDeps {
  sql: Sql;
  log: Logger;
  instance: ActiveInstance;
  /** Absolute skills dir (resolved once at boot via videoSkillsDir). */
  dir: string;
}

/**
 * W3b Skiller — project this instance's distilled Video Brand Guides
 * (video_ultra_profiles) into one SKILL.md per pattern under the operator vault.
 * The heavy lifting (schema-validate + render + fail-open write) lives in
 * emitSkillFiles; the tick just wires it to the instance and logs the count.
 */
export async function runSkillerTick(deps: SkillerTickDeps): Promise<{ written: number }> {
  const { sql, log, instance, dir } = deps;
  const { written, paths } = await emitSkillFiles({ sql, instanceId: instance.id, dir, log });
  log.info({ instance: instance.id, written, paths: paths.length, dir }, "skiller complete");
  return { written };
}

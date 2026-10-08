import type { Sql } from "postgres";
import type { VideoScriptOutput } from "@noelle/contracts";

/** Insert a generated draft (structure + script + asset suggestions) for an idea. */
export async function insertVideoDraft(
  sql: Sql,
  args: {
    orgId: string;
    instanceId: string;
    ideaId: string;
    platform: string;
    out: VideoScriptOutput;
    sourceEngine: string;
    model: string;
    /** Post-draft verifier verdict (null when verification is off). Renders as
     * the studio's verifier-trace card, exactly like the other interns' drafts. */
    qualityPassed?: boolean | null;
    verifierMeta?: unknown | null;
  },
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into noelle.video_drafts
      (org_id, agent_instance_id, idea_id, platform, structure, script,
       transitions, sounds, graph_specs, source_engine, model, status,
       quality_passed, verifier_meta)
    values (
      ${args.orgId}, ${args.instanceId}, ${args.ideaId}, ${args.platform},
      ${sql.json(args.out.structure as never)}, ${args.out.script},
      ${sql.json(args.out.transitions as never)}, ${sql.json(args.out.sounds as never)},
      ${sql.json(args.out.graphSpecs as never)}, ${args.sourceEngine}, ${args.model}, 'draft',
      ${args.qualityPassed ?? null},
      ${args.verifierMeta == null ? null : sql.json(args.verifierMeta as never)}
    )
    returning id`;
  return rows[0]!.id;
}

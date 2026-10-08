import type { JSONValue, Sql, TransactionSql } from "postgres";
import { BoundedPgSession } from "./boundedPgSession.js";

export interface PlaybookScope {
  orgId: string;
  agentInstanceId: string;
  platform: "x" | "linkedin";
}

export interface PlaybookUpsert extends PlaybookScope {
  authorHandle: string;
  fsdProfileId: string | null;
  hookPatterns: string[];
  structureNotes: string;
  cadenceNotes: string;
  topTopics: string[];
  engagementPercentile: number;
  samplePostIds: string[];
  model: string;
}

const sessions = new WeakMap<Sql, BoundedPgSession>();
function sessionFor(parent: Sql): BoundedPgSession {
  let session = sessions.get(parent);
  if (!session) {
    session = new BoundedPgSession(parent, {
      deadlineMs: 3000,
      maxPending: 32,
      idleTimeoutMs: 1000,
    });
    sessions.set(parent, session);
  }
  return session;
}

function validScope(scope: PlaybookScope): boolean {
  return (
    (scope.platform === "x" || scope.platform === "linkedin") &&
    typeof scope.orgId === "string" &&
    scope.orgId.trim() !== "" &&
    typeof scope.agentInstanceId === "string" &&
    scope.agentInstanceId.trim() !== ""
  );
}

function currentOwner(sql: Sql | TransactionSql, scope: PlaybookScope, lock = false) {
  return sql`select id, org_id from noelle.agent_instances
    where id=${scope.agentInstanceId} and org_id=${scope.orgId} and role=${scope.platform + "_intern"}
    ${lock ? sql`for no key update` : sql``}`;
}

/** Match the X sampler's existing normalization; LinkedIn samples use exact public slugs. */
function sameAuthor(sql: Sql | TransactionSql, platform: PlaybookScope["platform"]) {
  return platform === "x"
    ? sql`lower(regexp_replace(btrim(l.author_handle), '^@', ''))
        = lower(regexp_replace(btrim(p.author_handle), '^@', ''))`
    : sql`l.author_handle=p.author_handle`;
}

/** NULL/empty historical provenance remains style-only; supplied references must still agree. */
function coherentSources(sql: Sql | TransactionSql, platform: PlaybookScope["platform"]) {
  return sql`coalesce(cardinality(p.sample_post_ids),0)<=100 and not exists (
    select 1 from unnest(p.sample_post_ids) source(external_id)
    where source.external_id is null or btrim(source.external_id)='' or length(source.external_id)>2048
      or not exists (
        select 1 from noelle.leads l where l.external_id=source.external_id
          and l.org_id=p.org_id and l.agent_instance_id=p.agent_instance_id
          and l.platform=${platform} and ${sameAuthor(sql, platform)}
      )
  )`;
}

/** Persist only a current owner and its cited source posts; rejected writes are never acknowledged. */
export async function upsertPlaybook(parent: Sql, p: PlaybookUpsert): Promise<void> {
  if (
    !validScope(p) ||
    typeof p.authorHandle !== "string" ||
    !p.authorHandle.trim() ||
    !Array.isArray(p.samplePostIds) ||
    !p.samplePostIds.length ||
    p.samplePostIds.length > 100 ||
    p.samplePostIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 2048)
  ) {
    throw new Error("Invalid playbook owner or source references");
  }
  const samplePostIds = [...new Set(p.samplePostIds)];
  const written = await sessionFor(parent).run((sql) =>
    sql.begin(async (tx) => {
      await tx`set local lock_timeout='1s'`;
      await tx`set local statement_timeout='2s'`;
      await tx`set local idle_in_transaction_session_timeout='3s'`;
      const rows = await tx<{ id: string }[]>`
      with owner as materialized (${currentOwner(tx, p, true)}), incoming as (
        select ${p.orgId}::uuid as org_id, ${p.agentInstanceId}::uuid as agent_instance_id,
          ${p.authorHandle}::text as author_handle, ${samplePostIds}::text[] as sample_post_ids
      ), sources as materialized (
        select l.id, l.external_id from noelle.leads l
        join owner on owner.id=l.agent_instance_id and owner.org_id=l.org_id
        cross join incoming p
        where l.external_id=any(p.sample_post_ids) and l.platform=${p.platform}
          and ${sameAuthor(tx, p.platform)}
        order by l.id for share of l
      )
      insert into noelle.watchlist_playbooks
        (org_id, agent_instance_id, fsd_profile_id, author_handle, hook_patterns,
         structure_notes, cadence_notes, top_topics, engagement_percentile,
         sample_post_ids, model, generated_at)
      select p.org_id, p.agent_instance_id, ${p.fsdProfileId}, p.author_handle,
        ${tx.json(p.hookPatterns as unknown as JSONValue)}, ${p.structureNotes}, ${p.cadenceNotes},
        ${tx.json(p.topTopics as unknown as JSONValue)}, ${p.engagementPercentile},
        p.sample_post_ids, ${p.model}, now()
      from incoming p join owner on owner.id=p.agent_instance_id and owner.org_id=p.org_id
      where (select count(distinct external_id) from sources)=cardinality(p.sample_post_ids)
      on conflict (agent_instance_id, author_handle) do update set
        fsd_profile_id=excluded.fsd_profile_id, hook_patterns=excluded.hook_patterns,
        structure_notes=excluded.structure_notes, cadence_notes=excluded.cadence_notes,
        top_topics=excluded.top_topics, engagement_percentile=excluded.engagement_percentile,
        sample_post_ids=excluded.sample_post_ids, model=excluded.model, generated_at=excluded.generated_at
      where watchlist_playbooks.org_id=excluded.org_id
      returning id
    `;
      return rows.length;
    }),
  );
  if (written !== 1) throw new Error("Playbook owner or source provenance unavailable");
}

/** Fresh scoped playbooks let the analyst skip a refresh, including legacy style-only rows. */
export async function getFreshPlaybookAuthors(
  parent: Sql,
  args: PlaybookScope & { authorHandles: string[]; staleDays: number },
): Promise<Set<string>> {
  if (!validScope(args) || !args.authorHandles.length) return new Set();
  const rows = await sessionFor(parent).run(
    async (sql) =>
      await sql<{ author_handle: string }[]>`
    with owner as materialized (${currentOwner(sql, args)})
    select p.author_handle from noelle.watchlist_playbooks p
    join owner on owner.id=p.agent_instance_id and owner.org_id=p.org_id
    where p.author_handle in ${sql(args.authorHandles)}
      and p.generated_at>=now()-make_interval(days => ${args.staleDays})
      and ${coherentSources(sql, args.platform)}
  `,
  );
  return new Set(rows.map((row) => row.author_handle));
}

export interface PlaybookRow {
  authorHandle: string;
  hookPatterns: string[];
  structureNotes: string | null;
  cadenceNotes: string | null;
  topTopics: string[];
  engagementPercentile: number | null;
}

/** Best-performer style patterns for the current scoped owner, with cited provenance rechecked. */
export async function getTopPlaybooks(
  parent: Sql,
  args: PlaybookScope & { limit: number },
): Promise<PlaybookRow[]> {
  if (!validScope(args)) return [];
  const rows = await sessionFor(parent).run(
    async (sql) =>
      await sql<
        Array<{
          author_handle: string;
          hook_patterns: unknown;
          structure_notes: string | null;
          cadence_notes: string | null;
          top_topics: unknown;
          engagement_percentile: string | null;
        }>
      >`
    with owner as materialized (${currentOwner(sql, args)})
    select p.author_handle, p.hook_patterns, p.structure_notes, p.cadence_notes,
      p.top_topics, p.engagement_percentile
    from noelle.watchlist_playbooks p
    join owner on owner.id=p.agent_instance_id and owner.org_id=p.org_id
    where ${coherentSources(sql, args.platform)}
    order by p.engagement_percentile desc nulls last, p.author_handle
    limit ${args.limit}
  `,
  );
  return rows.map((row) => ({
    authorHandle: row.author_handle,
    hookPatterns: Array.isArray(row.hook_patterns) ? (row.hook_patterns as string[]) : [],
    structureNotes: row.structure_notes,
    cadenceNotes: row.cadence_notes,
    topTopics: Array.isArray(row.top_topics) ? (row.top_topics as string[]) : [],
    engagementPercentile:
      row.engagement_percentile == null ? null : Number(row.engagement_percentile),
  }));
}

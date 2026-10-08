import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  run: null as ((parts: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>) | null,
}));

vi.mock("@/lib/db", () => ({
  sql: (parts: TemplateStringsArray, ...values: unknown[]) => db.run!(parts, ...values),
  pgOrgMembersClient: () => ({}),
}));
vi.mock("@/lib/auth-cookie", () => ({ getUserFromCookies: async () => ({ id: "test-user" }) }));
vi.mock("@noelle/runtime", () => ({ assertOrgMember: async () => {} }));

import { getLinkedInPipelineSnapshot, getPipelineSnapshot } from "./queries";

const url = process.env.NOELLE_TEST_DATABASE_URL;

describe.skipIf(!url)("Pipeline post counts (integration)", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sql = postgres(url!, { max: 1 });
    const [row] = await sql<{ db: string }[]>`select current_database() as db`;
    if (!row?.db.includes("test")) throw new Error("Pipeline count tests require a test database");
  });
  afterAll(async () => { await sql?.end(); });

  it("counts post leads and distinct reply leads across X and LinkedIn without DM-only leads", async () => {
    const rollback = new Error("rollback test rows");
    try {
      await sql.begin(async (tx) => {
        db.run = (tx as unknown as NonNullable<typeof db.run>);
        // noelle_test predates the Pipeline UI migrations. These columns exist
        // in the live DB and are added only inside this rolled-back transaction.
        await tx.unsafe(`
          alter table noelle.agent_instances
            add column if not exists pipeline_started_at timestamptz,
            add column if not exists goal_started_at timestamptz,
            add column if not exists goal_target integer,
            add column if not exists discovery_enabled boolean default true,
            add column if not exists classifier_enabled boolean default true,
            add column if not exists drafter_enabled boolean default true,
            add column if not exists send_enabled boolean default true,
            add column if not exists profiler_enabled boolean default true,
            add column if not exists watchlist_enabled boolean default true,
            add column if not exists discovery_config jsonb,
            add column if not exists run_schedule jsonb,
            add column if not exists run_schedule_next_at timestamptz
        `);

        const orgId = randomUUID();
        await tx`insert into noelle.organizations (id, slug, name)
          values (${orgId}, ${`count-test-${orgId}`}, 'Pipeline count test')`;

        for (const [platform, role] of [["x", "x_intern"], ["linkedin", "linkedin_intern"]] as const) {
          const instanceId = randomUUID();
          await tx`insert into noelle.agent_instances
            (id, org_id, role, pipeline_started_at, goal_started_at, goal_target)
            values (${instanceId}, ${orgId}, ${role}, now() - interval '1 day', now() - interval '1 day', 80)`;

          const lead = async (marker: Record<string, string> = {}, suffix = "") => {
            const id = randomUUID();
            await tx`insert into noelle.leads
              (id, external_id, org_id, agent_instance_id, platform, payload, classifier_label)
              values (${id}, ${`${platform}:${id}${suffix}`}, ${orgId}, ${instanceId}, ${platform}, ${tx.json(marker)}, 'relevant')`;
            return id;
          };
          const draft = async (leadId: string, kind: "reply" | "dm", status: "pending" | "sent") => {
            const draftId = randomUUID();
            await tx`insert into noelle.drafts (id, lead_id, org_id, payload)
              values (${draftId}, ${leadId}, ${orgId}, ${tx.json({ kind, body: "fixture" })})`;
            await tx`insert into noelle.approvals
              (org_id, agent_instance_id, draft_id, lead_id, status, decided_at)
              values (${orgId}, ${instanceId}, ${draftId}, ${leadId}, ${status}, ${status === "sent" ? new Date() : null})`;
          };

          const firstPost = await lead();
          await draft(firstPost, "reply", "pending");
          await draft(firstPost, "reply", "pending");
          await draft(firstPost, "dm", "pending"); // companion DM on a real post
          const secondPost = await lead();
          await draft(secondPost, "reply", platform === "x" ? "sent" : "pending");
          const dmOnly = await lead({ post_kind: "relationship_dm" });
          await draft(dmOnly, "dm", "pending");
          const legacyDmOnly = await lead({ postKind: "intro_dm" });
          await draft(legacyDmOnly, "dm", "pending");
          const unmarkedIntroDm = await lead({}, ":intro");
          await draft(unmarkedIntroDm, "dm", "pending");
          const postWithoutReply = await lead();
          await draft(postWithoutReply, "dm", "pending");


          const snapshot = platform === "x"
            ? await getPipelineSnapshot(instanceId)
            : await getLinkedInPipelineSnapshot(instanceId);
          expect(snapshot).not.toBeNull();
          const counts = new Map(snapshot!.workers.map((worker) => [worker.kind, worker]));
          for (const window of ["lifetime", "today", "sinceStart"] as const) {
            expect(counts.get("discovery")?.[window]).toBe(3);
            expect(counts.get("classifier")?.[window]).toBe(3);
            expect(counts.get("drafter")?.[window]).toBe(2);
            if (platform === "x") expect(counts.get("send")?.[window]).toBe(1);
          }
          expect(snapshot!.leadsReady).toBe(platform === "x" ? 1 : 2);
          expect(snapshot!.leadsReadyLastRun).toBe(platform === "x" ? 1 : 2);
          expect(snapshot!.goal).toMatchObject({
            ready: platform === "x" ? 1 : 2,
            produced: 2,
          });
        }
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      db.run = null;
    }
  });
});

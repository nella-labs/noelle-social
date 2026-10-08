/** Legacy files whose outer transaction belongs to the migration ledger owner. */
const WRAPPED_MIGRATIONS = new Set([
  "0011_rename_drafter_codex_bucket.sql", "0017_purge_synthetic_leads.sql",
  "0063_merge_linkedin_duplicate_contacts.sql", "0080_dismiss_onbrand_slop_drafts.sql",
]);

/** Concurrent index builds cannot be enclosed in a transaction. */
export const CONCURRENT_INDEX_MIGRATIONS: Readonly<Record<string, { index: string; unique: boolean; columns: (string | null)[] }>> = {
  "0106_tenant_scoped_lead_identity.sql": {
    index: "leads_org_platform_external_id_uq", unique: true, columns: ["org_id", "platform", "external_id"],
  },
  "0115_notification_conversation_index.sql": {
    index: "leads_notification_conversation_idx", unique: false, columns: ["org_id", "agent_instance_id", "platform", null],
  },
};

/** Strip only known historical wrappers; reject unclassified transaction control. */
export function transactionalMigrationBody(filename: string, body: string): string {
  const controls = [...body.matchAll(/^\s*(begin|commit);\s*$/gim)];
  if (!WRAPPED_MIGRATIONS.has(filename)) {
    if (controls.length) throw new Error(`Transaction control requires migration policy: ${filename}`);
    return body;
  }
  if (controls.length !== 2 || controls[0]![1]!.toLowerCase() !== "begin" || controls[1]![1]!.toLowerCase() !== "commit")
    throw new Error(`Invalid historical transaction wrapper: ${filename}`);
  return body.replace(/^\s*(begin|commit);\s*$/gim, "");
}

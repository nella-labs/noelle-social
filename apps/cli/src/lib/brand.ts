import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { BrandConfigSchema, type BrandConfig } from "@noelle/contracts";
import type { Paths } from "../config.js";

/**
 * Operator brand config file lifecycle for the self-host CLI.
 *
 * `~/.noelle/brand.json` is a questionnaire the operator fills in — persona,
 * product/offer, pitch policy, reply + DM message styles, and brand Q&A. It is
 * validated against BrandConfigSchema and written to
 * `agent_instances.brand_config` so the drafter tailors replies + DMs to the
 * operator's business. Read fresh
 * each tick, so edits take effect next cycle.
 */

/**
 * The agent roles that draft outbound copy and therefore consume brand_config.
 * The operator's single brand.json applies to ALL of them so every intern
 * (Vega/X, Lyra/LinkedIn, Orion/Reddit) speaks in the same operator voice.
 * CEO/CMO don't draft and are intentionally excluded.
 */
export const DRAFTER_ROLES = ["x_intern", "linkedin_intern", "reddit_intern"] as const;

export function brandFilePath(paths: Paths): string {
  return resolve(paths.home, "brand.json");
}

/** Empty questionnaire fields become facts only after the operator fills them. */
export function scaffoldBrand(): BrandConfig {
  return BrandConfigSchema.parse({
    persona: { name: "", bio: "" },
    product: { name: "", description: "", url: "", install: "", surfaces: [], fits_when: [] },
    reply_style: { voice_notes: "", never_do: [] },
    dm_style: { greeting: "", closing: "", notes: "" },
    qa: [],
  });
}

export interface BrandFileResult {
  created: boolean;
  path: string;
}

/** Write the questionnaire scaffold if absent; never clobber an edited file. */
export function initBrandFile(paths: Paths): BrandFileResult {
  const path = brandFilePath(paths);
  if (existsSync(path)) return { created: false, path };
  writeFileSync(path, JSON.stringify(scaffoldBrand(), null, 2) + "\n", { mode: 0o644 });
  return { created: true, path };
}

/** Load + validate the brand file. Throws a readable error on bad JSON/shape. */
export function loadBrandFile(paths: Paths): BrandConfig {
  const path = brandFilePath(paths);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Could not read/parse ${path}: ${(err as Error).message}`);
  }
  const parsed = BrandConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`brand.json is invalid:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return parsed.data;
}

/**
 * Write the brand config to every drafting instance for the org (X, LinkedIn,
 * Reddit interns) so all of them share one operator voice. Returns rows updated.
 */
export async function applyBrand(args: {
  dbUrl: string;
  orgSlug: string;
  brand: BrandConfig;
}): Promise<number> {
  const sql = postgres(args.dbUrl, { max: 1, ssl: false, onnotice: () => {} });
  try {
    const rows = await sql`
      update noelle.agent_instances ai
      set brand_config = ${sql.json(args.brand as unknown as Parameters<typeof sql.json>[0])}
      from noelle.organizations o
      where ai.org_id = o.id and o.slug = ${args.orgSlug}
        and ai.role = any(${DRAFTER_ROLES as unknown as string[]})
      returning ai.id
    `;
    return rows.length;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

/**
 * Read the current brand config shared by the org's drafting instances. All
 * drafters carry the same brand, so the lowest-sorted role is representative.
 */
export async function showBrand(args: { dbUrl: string; orgSlug: string }): Promise<BrandConfig | null> {
  const sql = postgres(args.dbUrl, { max: 1, ssl: false, onnotice: () => {} });
  try {
    const rows = await sql<Array<{ brand_config: unknown }>>`
      select ai.brand_config
      from noelle.agent_instances ai
      join noelle.organizations o on o.id = ai.org_id
      where o.slug = ${args.orgSlug}
        and ai.role = any(${DRAFTER_ROLES as unknown as string[]})
      order by ai.role
      limit 1
    `;
    if (rows.length === 0) return null;
    return BrandConfigSchema.parse(rows[0]!.brand_config ?? {});
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

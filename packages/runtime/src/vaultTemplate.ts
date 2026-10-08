/**
 * Vault template renderer. Reads the static markdown templates under
 * `./vault-template/`, applies a Mustache-style substitution, and
 * returns the files that should be written for a given wizard stage.
 *
 * Files belong to a stage; rendering at "light" emits only the
 * light-stage files, "medium" adds the medium-stage files, etc.
 * Optional sections inside a file are gated by `{{#field.length}} …
 * {{/field.length}}` so a Light render with no Medium answers cleanly
 * omits the do/don't blocks.
 *
 * The substitution is intentionally tiny — Mustache spec sections +
 * variables only. We don't want a full templating engine here.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = join(HERE, "vault-template");

export type VaultWizardStage = "light" | "medium" | "rich";

export interface RenderedFile {
  path: string;
  body: string;
}

export interface RenderArgs {
  stage: VaultWizardStage;
  answers: Record<string, unknown>;
  slug: string;
}

const STAGE_PATHS: Record<VaultWizardStage, ReadonlySet<string>> = {
  light: new Set([
    "00-vault-map.md",
    "01-business/company.md",
    "02-brand/brand.md",
    "02-brand/voice-and-style.md",
    "03-voice-anchors/cadence.md",
    "03-voice-anchors/tone-rules.md",
    "03-voice-anchors/writing-rules.md",
    "04-content-system/weekly-themes.md",
    "05-templates/reply-contrarian.md",
    "05-templates/reply-empathetic.md",
    "05-templates/reply-technical.md",
    "06-inbox/README.md",
  ]),
  medium: new Set([
    "03-voice-anchors/banned-phrases.md",
    "04-content-system/pillars.md",
  ]),
  rich: new Set(["content/voice-anchors/samples.md"]),
};

export function renderVaultTemplate(args: RenderArgs): RenderedFile[] {
  const stages: VaultWizardStage[] =
    args.stage === "light"
      ? ["light"]
      : args.stage === "medium"
        ? ["light", "medium"]
        : ["light", "medium", "rich"];

  const out: RenderedFile[] = [];
  for (const stage of stages) {
    for (const p of STAGE_PATHS[stage]) {
      const src = readFileSync(join(TEMPLATE_ROOT, p), "utf8");
      out.push({ path: p, body: renderMustache(src, args.answers) });
    }
  }
  return out;
}

/**
 * Tiny Mustache subset:
 *   {{name}}                    → string interpolation
 *   {{#arr.length}} … {{/arr.length}} → render section if array is non-empty
 *   {{^arr.length}} … {{/arr.length}} → render section if array is empty
 *   {{#arr}} … {{/arr}}        → iterate array; {{.}} = current item
 * Variables resolve from the answers object only. Unknown keys render empty.
 */
function renderMustache(src: string, ctx: Record<string, unknown>): string {
  let out = src;

  // Inverted sections: {{^arr.length}} … {{/arr.length}}
  out = out.replace(
    /\{\{\^([a-zA-Z0-9_]+)\.length\}\}([\s\S]*?)\{\{\/\1\.length\}\}/g,
    (_m, key: string, body: string) => {
      const v = ctx[key];
      return Array.isArray(v) && v.length > 0 ? "" : body;
    },
  );

  // Length-guarded sections: {{#arr.length}} … {{/arr.length}}
  out = out.replace(
    /\{\{#([a-zA-Z0-9_]+)\.length\}\}([\s\S]*?)\{\{\/\1\.length\}\}/g,
    (_m, key: string, body: string) => {
      const v = ctx[key];
      return Array.isArray(v) && v.length > 0 ? body : "";
    },
  );

  // Iteration sections: {{#arr}} … {{/arr}}, with {{.}} for current item
  out = out.replace(
    /\{\{#([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_m, key: string, body: string) => {
      const v = ctx[key];
      if (!Array.isArray(v) || v.length === 0) return "";
      return v.map((item) => body.replace(/\{\{\.\}\}/g, String(item))).join("");
    },
  );

  // Scalar variable substitution.
  out = out.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, key: string) => {
    const v = ctx[key];
    return v === undefined || v === null ? "" : String(v);
  });

  return out;
}

/** Exposed for tests that need to enumerate the template tree. */
export function listTemplatePaths(): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(TEMPLATE_ROOT, full));
    }
  }
  walk(TEMPLATE_ROOT);
  return out.sort();
}

import { icpGateConfigured, qualifyByProfileText } from "@noelle/runtime";
import type { LeadRow } from "./leads-db.js";
import { readIcpGate } from "./icp-config.js";
import { detectLanguage } from "./language.js";
import { leadAge, MAX_LEAD_AGE_DAYS, type LeadAge } from "./recency.js";

export type ClassificationEligibility = {
  observed: boolean;
  age: LeadAge;
  drop: { label: string; meta: Record<string, unknown> } | null;
};

/** Deterministic admission shared by single-post and batch model dispatch. */
export function classificationEligibility(
  lead: LeadRow,
  inst: { icp_config?: unknown },
  now = new Date(),
): ClassificationEligibility {
  const payload = lead.payload;
  const observed = payload.source === "extension_observed";
  const age = leadAge(payload.posted_at, now);
  if (!observed && age.expired) {
    return {
      observed,
      age,
      drop: {
        label: "too_old",
        meta: {
          dropped: "too_old",
          posted_at: age.postedAtIso,
          age_days: age.ageDays,
          max_age_days: MAX_LEAD_AGE_DAYS,
        },
      },
    };
  }

  const lang = detectLanguage(typeof payload.text === "string" ? payload.text : "");
  if (lang.isNonEnglish) {
    return {
      observed,
      age,
      drop: {
        label: "non_english",
        meta: {
          skip_reason: "non-english",
          language: { reason: lang.reason, signals: lang.signals },
        },
      },
    };
  }

  const icpGate = readIcpGate(inst.icp_config);
  if (!observed && !lead.priority && icpGateConfigured(icpGate)) {
    const verdict = qualifyByProfileText(
      typeof payload.author_bio === "string" ? payload.author_bio : null,
      icpGate!,
      "accept",
    );
    if (!verdict.qualified) {
      return {
        observed,
        age,
        drop: {
          label: "off_icp",
          meta: {
            icp_gate: { qualified: false, reason: verdict.reason },
          },
        },
      };
    }
  }
  return { observed, age, drop: null };
}

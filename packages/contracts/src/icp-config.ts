import { z } from "zod";

// Profile-first discovery ICP (0043_linkedin_icp_config.sql). Per-instance
// definition of "the right person" plus the lead gate, stored on
// agent_instances.icp_config. NULL/absent = profile-first discovery is OFF and
// Lyra runs watchlist + keyword lanes exactly as before.
//
// Two consumers:
//   - Feeder A (HarvestAPI profile-search): the structured filters below map
//     straight onto the actor input (searchQuery + currentJobTitles + locations
//     + seniorityLevelIds + yearsOfExperienceIds + industryIds + schools).
//   - The AUTHOR gate (both feeders): headlineKeywords / headlineExcludeKeywords
//     decide whether a candidate person is the right kind of person — matched
//     against their LinkedIn headline. This is the "correct people, not the post"
//     filter the operator actually wants.
export const IcpConfigSchema = z
  .object({
    // ── Feeder A: profile-search actor inputs ──────────────────────────────
    /** Free-text people search (HarvestAPI `searchQuery`, supports operators). */
    searchQuery: z.string().max(300).optional(),
    /** Filter to these current job titles (actor `currentJobTitles`, max 50). */
    currentJobTitles: z.array(z.string().min(1)).max(50).optional(),
    /** Filter to these locations (actor `locations`, max 70). */
    locations: z.array(z.string().min(1)).max(70).optional(),
    /** Seniority level ids (actor `seniorityLevelIds`). HarvestAPI-specific codes. */
    seniorityLevelIds: z.array(z.string().min(1)).max(50).optional(),
    /** Years-of-experience ids (actor `yearsOfExperienceIds`) — proxy for "young". */
    yearsOfExperienceIds: z.array(z.string().min(1)).max(50).optional(),
    /** Industry ids (actor `industryIds`). HarvestAPI-specific codes. */
    industryIds: z.array(z.string().min(1)).max(50).optional(),
    /** Schools (actor `schools`, max 50). */
    schools: z.array(z.string().min(1)).max(50).optional(),
    /** Max profiles to pull from profile-search per tick. */
    maxProfiles: z.number().int().min(1).max(500).optional(),

    // ── Feeder B: keyword post-search ──────────────────────────────────────
    /**
     * Keyword queries for the post-search lane. When set, these REPLACE the
     * instance's noelle.linkedin_watchlist keywords for the profile-first run.
     * When absent, the existing watchlist keywords drive the search lane.
     */
    postQueries: z.array(z.string().min(1)).max(50).optional(),

    // ── The "right person" gate (both feeders) ─────────────────────────────
    /**
     * A candidate qualifies when their headline contains ANY of these
     * (case-insensitive substring). At least one is required — without it there
     * is no person gate and the feature would just be the old keyword lane.
     */
    headlineKeywords: z.array(z.string().min(1)).min(1),
    /** A candidate is rejected when their headline contains ANY of these. */
    headlineExcludeKeywords: z.array(z.string().min(1)).optional(),

    // ── Lead gate ──────────────────────────────────────────────────────────
    /** Min reactions on a post for it to become a lead. Default 10. */
    minReactions: z.number().int().min(0).optional(),
    /** Only posts newer than N hours become leads. Default 24. */
    timeWindowHours: z.number().int().min(1).max(168).optional(),
  })
  .strict();

export type IcpConfig = z.infer<typeof IcpConfigSchema>;

/** Lead-gate defaults when the ICP omits them. */
export const ICP_DEFAULT_MIN_REACTIONS = 10;
export const ICP_DEFAULT_TIME_WINDOW_HOURS = 24;
export const ICP_DEFAULT_MAX_PROFILES = 50;

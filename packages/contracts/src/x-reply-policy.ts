import { z } from "zod";

export const X_REPLY_MAX_AGE_HOURS_DEFAULT = 25;

/** Blank configuration keeps expiry enabled; only an explicit zero disables it. */
export const XReplyMaxAgeHoursSchema = z.preprocess(
  value => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.coerce.number().int().nonnegative().default(X_REPLY_MAX_AGE_HOURS_DEFAULT),
);

/** API callers retain their default when a nonblank setting is invalid. */
export function resolveXReplyMaxAgeHours(raw: string | undefined): number {
  const parsed = XReplyMaxAgeHoursSchema.safeParse(raw);
  return parsed.success ? parsed.data : X_REPLY_MAX_AGE_HOURS_DEFAULT;
}

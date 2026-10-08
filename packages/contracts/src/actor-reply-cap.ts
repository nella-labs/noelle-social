import { z } from "zod";

const configuredCap = z.number().int().min(0).max(500).nullable();

/** Omit or clear minimum to use the fixed cap; a daily range needs a ceiling. */
export const ActorReplyCapWriteSchema = z.object({
  cap: configuredCap,
  minimum: configuredCap.optional(),
}).strict().superRefine((value, context) => {
  if (value.minimum != null && (value.cap === null || value.minimum > value.cap)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["minimum"],
      message: "Daily minimum must not exceed a configured ceiling" });
  }
});
export type ActorReplyCapWrite = z.infer<typeof ActorReplyCapWriteSchema>;

/** cap is today's effective limit; policy metadata is present only for variation. */
export const ActorReplyCapStateSchema = z.object({
  sent: z.number().int().min(0),
  cap: z.number().int().min(0).nullable(),
  remaining: z.number().int().min(0).nullable(),
  configuredCap: configuredCap.optional(),
  minimum: configuredCap.optional(),
  day: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/).optional(),
});
export type ActorReplyCapState = z.infer<typeof ActorReplyCapStateSchema>;

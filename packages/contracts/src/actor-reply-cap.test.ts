import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import * as contracts from "./index.js";

function schema(name: string): ZodType {
  const value: unknown = Reflect.get(contracts, name);
  expect(value, `Missing public ${name}`).toBeDefined();
  return value as ZodType;
}

describe("actor reply cap contracts", () => {
  it.each([{ cap: 140 }, { cap: null }, { cap: 140, minimum: null },
    { cap: 140, minimum: 80 }, { cap: 0, minimum: 0 }, { cap: 500, minimum: 500 }])(
    "admits fixed or bounded daily policy %j", input => {
      expect(schema("ActorReplyCapWriteSchema").parse(input)).toEqual(input);
    },
  );

  it.each([{ cap: 140, minimum: 141 }, { cap: null, minimum: 80 },
    { cap: -1 }, { cap: 501 }, { cap: 140.5 }, { cap: 140, minimum: -1 },
    { cap: 140, minimum: 80.5 }, { cap: 140, minimum: "80" }])(
    "rejects an invalid ceiling or daily range %j", input => {
      expect(schema("ActorReplyCapWriteSchema").safeParse(input).success).toBe(false);
    },
  );

  it.each([{ sent: 7, cap: 140, remaining: 133 }, { sent: 0, cap: null, remaining: null }])(
    "preserves the fixed-mode response %j", input => {
      expect(schema("ActorReplyCapStateSchema").parse(input)).toEqual(input);
    },
  );

  it("keeps the configured ceiling separate from today's effective cap", () => {
    expect(schema("ActorReplyCapStateSchema").parse({
      sent: 7, cap: 103, remaining: 96, configuredCap: 140, minimum: 80, day: "2026-10-07",
    })).toEqual({ sent: 7, cap: 103, remaining: 96, configuredCap: 140, minimum: 80, day: "2026-10-07" });
  });

  it.each([{ sent: -1, cap: 140, remaining: 140 },
    { sent: 0, cap: 140.5, remaining: 140 }, { sent: 0, cap: 140, remaining: -1 },
    { sent: 0, cap: 100, remaining: 100, day: "07/10/2026" }])(
    "rejects malformed status %j", input => {
      expect(schema("ActorReplyCapStateSchema").safeParse(input).success).toBe(false);
    },
  );
});

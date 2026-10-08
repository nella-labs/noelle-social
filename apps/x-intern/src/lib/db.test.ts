import { afterEach, describe, expect, it } from "vitest";
import { __setDbClientForTests, noelleDb, resetDbClientForTests } from "./db.js";

describe("noelleDb", () => {
  afterEach(() => resetDbClientForTests());

  it("returns the injected stub when provided", () => {
    const stub = { select: 1 } as never;
    __setDbClientForTests(stub);
    expect(noelleDb()).toBe(stub);
  });
});

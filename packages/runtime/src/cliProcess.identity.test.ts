import { expect, it } from "vitest";
import * as shared from "@noelle/process";
import * as facade from "./cliProcess.js";
it("keeps the runtime CLI exports on the same process owner", () => {
  for (const [name, value] of Object.entries(facade)) expect(value).toBe(shared[name as keyof typeof shared]);
});

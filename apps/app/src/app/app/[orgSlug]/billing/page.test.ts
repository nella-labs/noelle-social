import { expect, test, vi } from "vitest";
const redirect = vi.hoisted(() => vi.fn(() => { throw new Error("redirect"); }));
vi.mock("next/navigation", () => ({ redirect }));
import BillingPage from "./page";
test("legacy billing goes to the real usage owner", async () => {
  await expect(BillingPage({ params: Promise.resolve({ orgSlug: "selected" }) })).rejects.toThrow("redirect");
  expect(redirect).toHaveBeenCalledWith("/app/selected/connections?tab=spend");
});

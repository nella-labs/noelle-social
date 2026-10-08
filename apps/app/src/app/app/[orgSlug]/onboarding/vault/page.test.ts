import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ org: vi.fn(), vault: vi.fn(), answers: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({}),
  notFound: () => { throw new Error("fixture_not_found"); },
  redirect: (url: string) => { throw new Error(`fixture_redirect:${url}`); },
}));
vi.mock("@/lib/queries", () => ({ getOrgBySlug: fixture.org }));
vi.mock("@/lib/vault", () => ({ getVaultForOrg: fixture.vault, getVaultWizardAnswersForOrg: fixture.answers }));
vi.mock("./actions", () => ({ submitVaultStage: vi.fn() }));
vi.mock("@/components/nav/AppLink", () => ({ AppLink: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children) }));
import VaultWizardPage from "./page";
beforeEach(() => {
  fixture.org.mockReset().mockResolvedValue({ id: "org", slug: "selected" });
  fixture.vault.mockReset().mockResolvedValue({ wizard_stage: "rich" });
  fixture.answers.mockReset().mockResolvedValue({ answers: { personName: "Saved identity", oneLineWhat: "Saved product", audience: "Saved audience" } });
});
async function render(step?: string) {
  return renderToStaticMarkup(await VaultWizardPage({ params: Promise.resolve({ orgSlug: "selected" }), searchParams: Promise.resolve(step ? { step } : {}) }));
}
test("explicit light reopens the actual saved identity form after rich completion", async () => {
  const html = await render("light"); expect(html).toContain('value="Saved identity"'); expect(html).toContain('value="Saved product"'); expect(html).toContain("Step 1 of 3");
});
test.each(["medium", "rich", "import"])("explicit %s remains reachable after completion", async step => {
  expect(await render(step)).toContain(step === "import" ? "Bring your own markdown" : `Step ${step === "medium" ? 2 : 3} of 3`);
});
test("fresh wizard starts at light", async () => {
  fixture.vault.mockResolvedValue(null); expect(await render()).toContain("Step 1 of 3");
});
test("default completed wizard preserves the settings redirect", async () => {
  await expect(render()).rejects.toThrow("fixture_redirect:/app/selected/settings");
});

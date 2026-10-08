// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApifyTokenSpend } from "@/lib/apify-spend-model";
import { apifyTokenSpend } from "@/lib/apify-spend-model";
import { ApifyExpenseHistory } from "./ApifyExpenseHistory";

function renderHistory(spend: ApifyTokenSpend[]): string {
  document.body.innerHTML = renderToStaticMarkup(createElement(ApifyExpenseHistory, { spend }));
  return document.body.textContent ?? "";
}

const providerBase = {
  source: "provider" as const,
  fetchedAt: "2026-09-17T12:00:00.000Z",
  cycleStartAt: "2026-08-30T00:00:00.000Z",
  cycleEndAt: "2026-09-29T23:59:59.999Z",
};

describe("ApifyExpenseHistory", () => {
  it("displays saved retired provider balances", () => {
    const text = renderHistory([
      {
        ...providerBase,
        credentialId: "cred_retired",
        label: "retired account",
        active: false,
        cents: 250,
        accountId: "account_retired",
      },
    ]);

    expect(text).toContain("retired account · retired");
    expect(text).toContain("$2.50");
    expect(text).toContain("Last reported total$2.50");
    expect(text).not.toContain("No provider balances fetched yet");
  });

  it("counts duplicate provider accounts once and keeps unverified spend out of the reported total", () => {
    const text = renderHistory([
      {
        ...providerBase,
        credentialId: "cred_retired",
        label: "shared retired",
        active: false,
        cents: 250,
        accountId: "account_shared",
      },
      {
        ...providerBase,
        credentialId: "cred_active",
        label: "shared active",
        active: true,
        cents: 250,
        accountId: "account_shared",
      },
      {
        credentialId: null,
        label: "",
        active: false,
        cents: 175,
        source: "unverified",
      },
    ]);

    expect(text).toContain("shared active");
    expect(text).not.toContain("shared retired");
    expect(text).toContain("Last reported total$2.50");
    expect(text).toContain("Run charges · unverified");
    expect(text).toContain("Unknown token · retired");
    expect(text).toContain("$1.75");
    expect(text).not.toContain("$4.25");
    expect(text).not.toContain("$5.00");
  });

  it("preserves a fetched provider zero instead of showing the empty state", () => {
    const text = renderHistory([
      {
        ...providerBase,
        credentialId: "cred_zero",
        label: "zero account",
        active: true,
        cents: 0,
        accountId: "account_zero",
      },
    ]);

    expect(text).toContain("zero account");
    expect(text).toContain("$0.00");
    expect(text).toContain("Last reported total$0.00");
    expect(text).not.toContain("No provider balances fetched yet");
  });

  it("renders charges after a saved reading without adding them to the provider total", () => {
    const text = renderHistory(apifyTokenSpend([{
      ...providerBase, fetchedAt: "2026-09-02T12:00:00.000Z", credentialId: "credential",
      label: "Fixture account", active: true, accountId: "account", usageUsd: 1,
      dailyUsage: [{ date: "2026-09-02", usageUsd: 1 }],
    }], [{ credentialId: "credential", label: "Fixture account", active: true,
      day: "2026-09-17", cents: 250 }]));

    expect(text).toContain("Last reported total$1.00");
    expect(text).toContain("Run charges · unverified");
    expect(text).toContain("$2.50");
    expect(text).not.toContain("$3.50");
  });
});

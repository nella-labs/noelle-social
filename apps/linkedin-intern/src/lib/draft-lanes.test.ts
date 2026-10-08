import { describe, expect, it } from "vitest";
import { planDraftLanes } from "./draft-lanes.js";

describe("planDraftLanes", () => {
  it("routes browser-qualified posts through mandatory verification ahead of ordinary leads", () => {
    const observed = { id: "browser", classifier_label: "light", payload: { source: "extension_observed" } } as never;
    const watched = { id: "watched", classifier_label: "substantial", payload: {} } as never;
    const keyword = { id: "keyword", classifier_label: "light", payload: {} } as never;
    expect(planDraftLanes({ observed: [observed], priority: [watched], keyword: [keyword] })).toEqual([
      { leads: [observed], forceVerify: true },
      { leads: [watched, keyword], forceVerify: false },
    ]);
  });

  it("does not schedule an empty verified pass", () => {
    expect(planDraftLanes({ observed: [], priority: [], keyword: [] })).toEqual([
      { leads: [], forceVerify: false },
    ]);
  });

  it("forces verification for browser leads spilled into legacy priority and keyword claims", () => {
    const priorityBrowser = { id: "priority-browser", payload: { source: "extension_observed" } } as never;
    const keywordBrowser = { id: "keyword-browser", payload: { source: "extension_observed" } } as never;
    const watched = { id: "watched", payload: { source: "watchlist" } } as never;
    expect(planDraftLanes({
      observed: [], priority: [priorityBrowser, watched], keyword: [keywordBrowser],
    })).toEqual([
      { leads: [priorityBrowser, keywordBrowser], forceVerify: true },
      { leads: [watched], forceVerify: false },
    ]);
  });
});

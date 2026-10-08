// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { FeederSourceProfile, StyleSamplePost } from "@/lib/feeder-queries";

const action = vi.hoisted(() => ({ toggle: vi.fn(async () => ({ ok: false })) }));
vi.mock("./actions", () => ({ toggleFeederSource: action.toggle }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { FeederCorpusCard } from "./FeederCorpusCard";

const source: FeederSourceProfile = { sourceId: "source-id", platform: "x", handle: "sample_source",
  displayName: "Sample source", enabled: true, lastPulledAt: null, postCount: 2, commentCount: 0,
  profile: null, contactPersonId: null, draftsUsed: 0, totalStyledDrafts: 0, avgWeight: null };
const sample = (likes: number | null, comments: number | null): StyleSamplePost => ({ handle: source.handle,
  kind: "post", body: "Saved corpus sample", likeCount: likes, commentCount: comments, postedAt: null } as StyleSamplePost);
const element = (samples: StyleSamplePost[]) => createElement(FeederCorpusCard, { orgSlug: "sample-org",
  instanceId: "instance-id", sources: [source], samples });
afterEach(() => { document.body.innerHTML = ""; action.toggle.mockClear(); });

it("labels both unknown counters explicitly", () => {
  expect(renderToStaticMarkup(element([sample(null, null)]))).toContain("unknown likes · unknown comments");
});

it("retains measured zero beside an unknown counter", () => {
  expect(renderToStaticMarkup(element([sample(0, null)]))).toContain("0 likes · unknown comments");
});

it("expands samples and retains the existing source toggle interaction", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element([sample(0, 2)])));
  const details = container.querySelector("details")!;
  container.querySelector("summary")!.click();
  expect(details.open).toBe(true);
  expect(details.textContent).toContain("0 likes · 2 comments");
  const toggle = container.querySelector<HTMLButtonElement>("button")!;
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  await act(async () => toggle.click());
  expect(action.toggle).toHaveBeenCalledWith({ orgSlug: "sample-org", instanceId: "instance-id", rowId: "source-id", enabled: false });
  await act(async () => root.unmount());
});

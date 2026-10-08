import { expect, test } from "vitest";
import { isAllSkipDraft } from "./is-skip-draft";
import type { DraftPayloadView } from "./payload-shapes";

test("an authoritative skip edit replaces an originally useful flat body", () => {
  expect(isAllSkipDraft({ angle: "technical", body: "Useful reply", edited_body: "SKIP: no fit" })).toBe(true);
});

test.each([[null], [0], [{}], [[]], [""], ["   "]])("a cleared or invalid edit does not revive an old skip body: %j", (edit) => {
  expect(isAllSkipDraft({ angle: "technical", body: "SKIP: no fit", edited_body: edit } as DraftPayloadView)).toBe(false);
});

test("a surviving unedited bundle variant remains reviewable", () => {
  expect(isAllSkipDraft({ angle: "technical", edited_body: "SKIP: no fit", angles: {
    technical: { body: "Old technical" }, contrarian: { body: "Useful alternative" },
  } })).toBe(false);
});

test("an ambiguous legacy bundle edit does not classify stale variants", () => {
  expect(isAllSkipDraft({ edited_body: null, angles: {
    empathetic: { body: "SKIP: no fit" }, technical: { body: "SKIP: no fit" },
  } })).toBe(false);
});

test("all visible bundle variants must be skips before the whole draft is hidden", () => {
  expect(isAllSkipDraft({ angles: { empathetic: { body: "SKIP: no fit" }, technical: { body: "Recommend skipping" } } })).toBe(true);
  expect(isAllSkipDraft({ body: "Useful reply" })).toBe(false);
});

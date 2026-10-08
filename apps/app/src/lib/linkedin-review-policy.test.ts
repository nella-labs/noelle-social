import { expect, test, vi } from "vitest";

const { fetchPolicy } = vi.hoisted(() => ({ fetchPolicy: vi.fn() }));
vi.mock("@/lib/api", () => ({ noelleFetch: fetchPolicy }));

import { loadLinkedInVoiceFloor } from "./linkedin-review-policy";

const orgId = "11111111-1111-4111-8111-111111111111";

test("uses the actor API's current voice floor, even when it differs from app env", async () => {
  process.env.LINKEDIN_AUTOSEND_VOICE_FLOOR = "0.7";
  fetchPolicy.mockResolvedValueOnce({ org_id: orgId, voice_floor: 0.9 });
  expect(await loadLinkedInVoiceFloor(orgId)).toBe(0.9);
  expect(fetchPolicy).toHaveBeenCalledWith(`/api/linkedin-review-policy?org_id=${orgId}`);
  delete process.env.LINKEDIN_AUTOSEND_VOICE_FLOOR;
});

test("fails closed when the policy API is unavailable or malformed", async () => {
  fetchPolicy.mockRejectedValueOnce(new Error("API offline"));
  expect(await loadLinkedInVoiceFloor(orgId)).toBeNull();
  fetchPolicy.mockResolvedValueOnce({ org_id: orgId, voice_floor: 1.5 });
  expect(await loadLinkedInVoiceFloor(orgId)).toBeNull();
  fetchPolicy.mockResolvedValueOnce({ org_id: "wrong-org", voice_floor: 0.7 });
  expect(await loadLinkedInVoiceFloor(orgId)).toBeNull();
});

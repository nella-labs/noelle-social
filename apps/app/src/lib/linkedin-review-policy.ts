import { noelleFetch } from "@/lib/api";

/** The actor API owns this send gate; an unavailable policy cannot imply readiness. */
export async function loadLinkedInVoiceFloor(orgId: string): Promise<number | null> {
  try {
    const policy = await noelleFetch<unknown>(
      `/api/linkedin-review-policy?org_id=${encodeURIComponent(orgId)}`,
    );
    if (!policy || typeof policy !== "object") return null;
    const { org_id, voice_floor } = policy as Record<string, unknown>;
    if (org_id !== orgId || typeof voice_floor !== "number"
      || !Number.isFinite(voice_floor) || voice_floor < 0 || voice_floor > 1) return null;
    return voice_floor;
  } catch {
    return null;
  }
}

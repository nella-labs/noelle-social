/** The threshold used by every unattended LinkedIn reply gate. */
export function resolveLinkedInVoiceFloor(): number {
  const configured = Number(process.env.LINKEDIN_AUTOSEND_VOICE_FLOOR ?? 0.7);
  return Number.isFinite(configured)
    ? Math.min(1, Math.max(0, configured))
    : 0.7;
}

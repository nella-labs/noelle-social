// Outbound DM count chooses a drafting rung; it does not establish a reply,
// mutual exchange, interest, or relationship warmth. Only the invite rung
// permits one optional call suggestion.

export interface DmRung {
  /** 1-based rung number shown to the operator (1..4). */
  index: number;
  id: "open" | "deepen" | "bridge" | "invite";
  /** Short human label (approval badge / logs). */
  label: string;
  /** Only the top rung may propose a call — this gates the prompt's call policy. */
  proposesCall: boolean;
  /** What THIS DM should do — injected into the DM prompt as the rung directive. */
  directive: string;
}

// Rung index in the array is (sentCount clamped) → so DM_RUNGS[0] is the first
// touch (0 sent). Keep exactly four; pickRung clamps to the last.
export const DM_RUNGS: readonly DmRung[] = [
  {
    index: 1,
    id: "open",
    label: "Open",
    proposesCall: false,
    directive:
      "This is an early, light first touch. React to ONE specific thing in their post and ask one genuine, curious question about it. Ask for nothing else. Do NOT propose a call, a meeting, or 'hopping on' anything, and do not pitch. Just start a real conversation.",
  },
  {
    index: 2,
    id: "deepen",
    label: "Deepen",
    proposesCall: false,
    directive:
      "One earlier outbound DM is recorded. This does not prove a response or mutual exchange. Go one layer deeper: react to something specific in their post and share ONE short, true bit of your own experience that it genuinely connects to. Still ask for nothing, still no call and no pitch. You are building rapport, not selling.",
  },
  {
    index: 3,
    id: "bridge",
    label: "Bridge",
    proposesCall: false,
    directive:
      "Two earlier outbound DMs are recorded; do not infer interest or warmth from that count. Name a grounded overlap between what they're working on and what you're working on, and float that it could be worth comparing notes at some point. Keep it soft and optional. Do NOT propose a specific call or time yet, and do not pitch.",
  },
  {
    index: 4,
    id: "invite",
    label: "Invite",
    proposesCall: true,
    directive:
      "Three or more outbound DMs are recorded, so one optional call invite is allowed at this rung. That count does not prove a response, mutual interest, or a warm relationship. Never imply a prior exchange without recorded received evidence. Propose ONE low-pressure, easy-to-decline quick call (around 15 minutes, no agenda), framed as genuinely wanting to hear how they think about their work. Make it a single, gentle invite they can say no to with zero friction. Never pushy, never a hard sell, no pitch.",
  },
] as const;

/**
 * Pick the rung for a person from how many DMs have already been SENT to them.
 * 0 sent → rung 1 (Open); 1 → Deepen; 2 → Bridge; 3+ → rung 4 (Invite, the only
 * rung that proposes a call). Guards NaN / negative / fractional inputs.
 */
export function pickRung(sentCount: number): DmRung {
  const n = Number.isFinite(sentCount) ? Math.max(0, Math.trunc(sentCount)) : 0;
  const idx = Math.min(n, DM_RUNGS.length - 1);
  return DM_RUNGS[idx]!;
}

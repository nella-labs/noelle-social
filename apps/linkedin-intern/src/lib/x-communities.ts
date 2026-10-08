// X (Twitter) communities the 3 fresh X variants are framed for — content-
// pipeline's "one version per fitting community" model. The same core idea, the
// framing/emphasis shifted for each audience, so the 3 X posts are genuinely
// distinct rather than three rewordings of one line.
//
// A sensible inline default (no per-org config yet). The drafter cycles through
// these by version index; absent/empty ⇒ no community framing (byte-identical to
// the pre-community prompt).

export interface XCommunity {
  name: string;
  /** One line on who they are + what lands with them. */
  desc: string;
}

export const X_COMMUNITIES: XCommunity[] = [
  {
    name: "Build in Public",
    desc: "founders shipping in the open; reward candor, real numbers, and what's actually hard, not polish.",
  },
  {
    name: "Tech Twitter",
    desc: "engineers + builders; reward a sharp technical take, a concrete result, or a contrarian opinion.",
  },
  {
    name: "Startup / Founders",
    desc: "early-stage founders + operators; reward GTM, hiring, fundraising and the honest tradeoffs behind them.",
  },
  {
    name: "Indie Hackers",
    desc: "bootstrappers chasing revenue + leverage; reward small, repeatable wins and anti-hype pragmatism.",
  },
  {
    name: "AI / ML",
    desc: "people building with models; reward a specific capability, a failure mode, or a non-obvious use.",
  },
];

/** The community for the v-th X variant (cycles); null when none configured. */
export function communityForVariant(index: number, communities: XCommunity[] = X_COMMUNITIES): XCommunity | null {
  if (communities.length === 0) return null;
  return communities[index % communities.length] ?? null;
}

/** Shared social-profile glyphs and operator monograms. */

export type AvatarRole =
  | "you"
  | "content"
  | "x-intern"
  | "linkedin-intern"
  | "reddit-intern"
  | "video-intern";

interface AvatarProps {
  role: AvatarRole | string;
  size?: number;
  accent?: string;
  monogram?: string;
}

export function Avatar({ role, size = 44, accent, monogram }: AvatarProps) {
  const s = size;
  const half = s / 2;
  const acc = accent ?? "var(--accent)";
  // Style helpers — CSS variables only resolve through inline style.
  const fillAcc = { fill: acc } as const;
  const strokeAcc = { stroke: acc, fill: "none" } as const;
  const paperStroke = { stroke: "var(--paper)" } as const;

  const glyph = (() => {
    switch (role) {
      case "you":
        return (
          <text
            x={half}
            y={half + s * 0.13}
            fontSize={s * 0.5}
            textAnchor="middle"
            style={{ fontFamily: "var(--display, 'Instrument Serif', Georgia, serif)", fill: acc }}
          >
            {monogram ?? "U"}
          </text>
        );
      case "content":
        return (
          <g style={fillAcc}>
            <rect x={half - s * 0.22} y={half - s * 0.18} width={s * 0.20} height={s * 0.36} rx={s * 0.02} />
            <rect x={half + s * 0.02} y={half - s * 0.18} width={s * 0.20} height={s * 0.36} rx={s * 0.02} opacity={0.75} />
          </g>
        );
      case "x-intern":
        return (
          <g>
            <circle cx={half - s * 0.04} cy={half} r={s * 0.18} style={fillAcc} />
            <polygon
              points={`${half + s * 0.14},${half - s * 0.04} ${half + s * 0.28},${half} ${half + s * 0.14},${half + s * 0.04}`}
              style={fillAcc}
            />
            <line
              x1={half - s * 0.10}
              y1={half - s * 0.02}
              x2={half + s * 0.06}
              y2={half - s * 0.10}
              strokeWidth={s * 0.04}
              strokeLinecap="round"
              style={paperStroke}
            />
          </g>
        );
      case "linkedin-intern":
        return (
          <g style={fillAcc}>
            <rect x={half - s * 0.22} y={half - s * 0.10} width={s * 0.10} height={s * 0.28} rx={s * 0.02} />
            <circle cx={half - s * 0.17} cy={half - s * 0.20} r={s * 0.055} />
            <rect x={half - s * 0.04} y={half - s * 0.10} width={s * 0.10} height={s * 0.28} rx={s * 0.02} />
            <rect x={half + s * 0.10} y={half - s * 0.04} width={s * 0.10} height={s * 0.22} rx={s * 0.02} opacity={0.7} />
          </g>
        );
      case "reddit-intern":
        return (
          <g
            strokeWidth={s * 0.05}
            strokeLinecap="round"
            style={strokeAcc}
          >
            <circle cx={half} cy={half + s * 0.05} r={s * 0.20} style={{ fill: acc, stroke: "none" }} />
            <line x1={half - s * 0.10} y1={half - s * 0.20} x2={half - s * 0.18} y2={half - s * 0.30} />
            <line x1={half + s * 0.10} y1={half - s * 0.20} x2={half + s * 0.18} y2={half - s * 0.30} />
            <circle cx={half - s * 0.18} cy={half - s * 0.30} r={s * 0.04} style={{ fill: acc, stroke: "none" }} />
            <circle cx={half + s * 0.18} cy={half - s * 0.30} r={s * 0.04} style={{ fill: acc, stroke: "none" }} />
          </g>
        );
      case "video-intern":
        // Nova — a vertical 9:16 reel (IG/TikTok), distinct from the
        // landscape "video-editor" monitor: a portrait frame + play mark.
        return (
          <g>
            <rect
              x={half - s * 0.16}
              y={half - s * 0.24}
              width={s * 0.32}
              height={s * 0.48}
              rx={s * 0.06}
              strokeWidth={s * 0.045}
              style={{ ...strokeAcc }}
            />
            <polygon
              points={`${half - s * 0.07},${half - s * 0.10} ${half + s * 0.10},${half} ${half - s * 0.07},${half + s * 0.10}`}
              style={fillAcc}
            />
          </g>
        );
      default:
        return <circle cx={half} cy={half} r={s * 0.15} style={fillAcc} />;
    }
  })();

  return (
    <svg
      width={s}
      height={s}
      viewBox={`0 0 ${s} ${s}`}
      style={{
        display: "block",
        borderRadius: "50%",
        background: "var(--paper-2)",
        boxShadow: "0 0 0 0.5px var(--rule), 0 1px 2px rgba(31,26,18,.05)",
        flexShrink: 0,
      }}
      aria-hidden
    >
      {glyph}
    </svg>
  );
}

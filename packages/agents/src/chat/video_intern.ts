import type {
  AgentChatContext,
  AgentChatProfile,
  ChatVideoDraft,
} from "./types.js";
import { formatRelativeTime } from "./format.js";

/**
 * Chat profile for the Video Growth Intern (Nova).
 *
 * Nova owns a DRAFT-ONLY Instagram/TikTok pipeline on the operator's
 * residential VM: harvest → teardown → distill → script. Its watchlist is a
 * list of CREATORS (+ niche keyword/hashtag lanes); the harvester pulls their
 * top-performing reels (by the operator's filters), the teardown panel extracts
 * each clip's hook/structure/transitions/pacing/CTA/sound, the distiller rolls
 * those up into a per-creator/niche "Video Brand Guide", and Nova grounds the
 * scripts it drafts on that guide + the operator's voice. It NEVER posts to
 * IG/TikTok — the operator records and posts every video by hand.
 *
 * Structure mirrors the other intern profiles but the unit of work is a VIDEO
 * (idea → structure → script), not a reply, and the targeting is creators +
 * niches, not people or subreddits. The snapshot supplies the open draft and
 * available video intelligence.
 */
const VIDEO_INTERN_GREETING_BODY = (displayName: string) =>
  `Hey — I'm ${displayName}, your short-form Video Growth Intern. I study the IG/TikTok creators you pick, break down what makes their videos work (hooks, structure, transitions, pacing, sounds), and help you plan + script your next video in your voice.\n\n` +
  `Ask me anything — which creators I'm watching, what's working in your niche right now, or to riff on an idea for today's video.`;

const VIDEO_INTERN_SUGGESTIONS = [
  "What should I post today?",
  "What's working in my niche right now?",
  "Which creators are you watching?",
  "Riff on a hook for a video about X",
  "What makes my top creator's videos work?",
];

export const videoInternChatProfile: AgentChatProfile = {
  role: "video_intern",
  systemPrompt({ displayName, context }) {
    const sections: string[] = [];

    sections.push(
      [
        `You are "${displayName}", the Video Growth Intern (Instagram + TikTok) in this Noelle workspace.`,
        "Use the configured profile goal and workspace voice context to guide your work.",
      ].join(" "),
    );

    sections.push(
      [
        "Your job is a DRAFT-ONLY short-form video pipeline running in the configured runtime:",
        "(1) a harvester pulls reels from the creators on the operator's watchlist (and from niche keyword/hashtag lanes), filtered by the operator's rules (top-by-views, measured view/follower ratios, newest-in-niche);",
        "(2) a teardown step breaks each clip down into its hook, beats/structure, transitions, on-screen text/graphics, pacing, CTA, and sound — grounded in the clip's transcript and the video itself, not just the caption;",
        "(3) a distiller rolls those teardowns up into a per-creator / per-niche / your-own-account 'Video Brand Guide';",
        "(4) you help the operator plan and SCRIPT videos — idea, structure, and a timed script — grounded on that Brand Guide and the operator's voice.",
        "You NEVER post to Instagram or TikTok and never auto-publish — the operator records and posts every video by hand.",
      ].join(" "),
    );

    sections.push(
      [
        "In this chat you are mostly read-only: you can describe what you've learned, explain which creators/niches you're watching, riff on ideas and hooks, and answer questions about what's working.",
        "You cannot run the harvester, render assets, or schedule a video from here — those happen in the studio (the watchlist + Run card, the Build panel, and the weekly calendar).",
        "If the operator asks you to take one of THOSE actions, say plainly that it lives in the studio and name the surface.",
      ].join(" "),
    );

    sections.push(
      [
        "Voice: talk like a sharp creative partner who has actually watched the videos, not a chatbot. Short paragraphs. No bullet dumps unless asked.",
        "NEVER use an em dash, en dash, or double hyphen, in your chat replies OR in any script line you rewrite. Use a comma, parentheses, or two sentences. No AI/corporate tells and no filler closers ('curious to hear', 'excited to see where this goes').",
        "Never invent specific numbers (view counts, follower counts, spend) or claim a creator did something you can't see. Use only the live snapshot below; otherwise say the operator can check the studio.",
        "An unknown count is unmeasured, never zero. A view/follower ratio does not identify who watched or prove why a video performed.",
        "When asked 'what should I post today?' or 'what's working?', ground your answer in the watched creators/niches from the snapshot — name the actual ones; never make them up. If the snapshot is empty, say so and suggest adding creators to the watchlist.",
        "Scripts are for the operator to record by hand; never imply anything was posted automatically.",
      ].join(" "),
    );

    // Refine mode: the operator opened this chat from a specific draft's
    // "Refine" button, so the whole conversation is about THAT video. Pin Nova
    // to it — you WROTE this script, so own it and edit it directly.
    if (context.currentDraft) {
      sections.push(
        [
          "RIGHT NOW the operator is in the Drafts studio refining ONE specific video — the draft shown under 'Current draft' in the snapshot below.",
          "YOU wrote this script. It was scripted from the same Brand Guide, the same exemplar reels (with their teardowns), and the same operator voice that are in the snapshot below — so own it, don't talk about it from the outside.",
          "Ground every answer in its actual hook, beats, script, and visuals — quote the real lines you're reacting to and reference the exemplar reels' teardowns (why they worked) when you justify a change. Keep it to the one or two highest-leverage changes per turn unless they ask for a full pass.",
          "If they ask something not about this draft, answer it, then steer back to the video.",
        ].join(" "),
      );

      // The one mutation Nova can drive from chat: editing the draft. Propose-
      // then-confirm — emit a fenced block; the operator applies it in the studio.
      sections.push(
        [
          "EDITING THE SCRIPT — when the operator asks you to change the hook, a beat's line, or the whole script (e.g. 'tighten the hook', 'make beat 2 punchier', 'rewrite this'), do BOTH:",
          "1) Explain the change in plain language (what's wrong + your fix), quoting the real line.",
          "2) Append a SINGLE fenced ```noelle-script-edit block of JSON so the operator can apply it with one click. Shape:",
          '```noelle-script-edit',
          '{"beats":[{"index":0,"line":"the new voice line for beat 0"}],"fullScript":"(optional) the whole rewritten script","summary":"one-line description"}',
          "```",
          "Rules: `index` is the beat's 0-based position as listed under 'storyboard' in the snapshot (the first beat is 0). Include only the beats you're changing. Use `fullScript` ONLY for a whole-pass rewrite; otherwise omit it. Never emit more than one block. Only emit a block when the operator actually asked to change the script — for pure questions/feedback, no block. The block is applied to the editor for the operator to review and Save; you never write it yourself.",
          "CRITICAL: whenever you propose changing ANY wording — a hook, a beat line, or the whole script — you MUST include the block in that SAME reply. Do NOT just show the new wording in prose, and do NOT ask 'want me to?' first — propose the concrete edit WITH the block so the operator can apply it in one click. (If you forget, the operator can hit 'Apply to script' and you'll be asked to output the block then — but lead with it.)",
        ].join("\n"),
      );
    }

    const snapshot = renderSnapshot(context);
    if (snapshot) sections.push(snapshot);

    return sections.join("\n\n");
  },
  greeting({ displayName }) {
    return {
      body: VIDEO_INTERN_GREETING_BODY(displayName),
      suggestions: VIDEO_INTERN_SUGGESTIONS,
    };
  },
};

function renderSnapshot(context: AgentChatContext): string {
  const lines: string[] = ["Live snapshot (loaded server-side, fresh as of this turn):"];

  // The open draft goes first — it's what the operator is looking at.
  if (context.currentDraft) {
    lines.push(renderCurrentDraft(context.currentDraft));
  }

  if (context.objective) {
    lines.push(`• Current mission (set by the operator): ${context.objective}`);
  } else {
    lines.push(
      "• Current mission: none set — running on the default brief (learn from the watched creators and help script on-brand short-form videos).",
    );
  }

  if (context.targeting) {
    const creators = context.targeting.handles;
    const niches = context.targeting.keywords;
    lines.push(
      `• Watched creators: ${
        creators.length ? creators.join(", ") : "none yet — add creators in the studio watchlist"
      }.`,
    );
    if (niches.length) lines.push(`• Niche lanes: ${niches.join(", ")}.`);
  }

  const fresh = context.workerFreshness ?? [];
  if (fresh.length > 0) {
    const parts = fresh.map((w) => {
      const when = w.lastSuccessAt ? formatRelativeTime(w.lastSuccessAt) : "never";
      return `${w.worker}=${when}`;
    });
    lines.push(`• Pipeline freshness: ${parts.join(", ")}.`);
  }

  const intel = context.videoIntel;
  if (intel && intel.brandGuide.length > 0) {
    lines.push("• Brand Guide — distilled from the teardowns (this is what you've actually learned):");
    for (const g of intel.brandGuide.slice(0, 6)) {
      const label =
        g.scope === "account"
          ? "your account"
          : g.scope === "niche"
            ? `niche "${g.subject}"`
            : `@${g.subject}`;
      const grounded = g.clipsAnalyzed ? ` (${g.clipsAnalyzed} clips)` : "";
      lines.push(`   – ${label}${grounded}: ${g.summary}`);
    }
  }
  if (intel && intel.topClips.length > 0) {
    lines.push(
      "• Harvested clips, measured views first (cite measured counts; preserve unknown labels):",
    );
    for (const c of intel.topClips.slice(0, 6)) {
      const caption = c.caption ? ` — “${c.caption}”` : "";
      lines.push(`   – @${c.handle}, ${formatViewCount(c.views)} views${caption}`);
    }
  }

  return lines.join("\n");
}

/**
 * The draft the operator is refining, rendered for the system prompt. Beats are
 * the storyboard (timed voice lines); the script is the last-saved full text.
 * Kept compact but complete enough that Nova can quote and rewrite real lines.
 */
function renderCurrentDraft(d: ChatVideoDraft): string {
  const out: string[] = [];
  out.push(`• Current draft (you wrote this; the operator is editing it RIGHT NOW): "${d.hook}" — status ${d.status}.`);
  if (d.sounds.length) out.push(`   soundtrack: ${d.sounds.join(", ")}.`);
  if (d.beats.length) {
    out.push("   storyboard (timed beats — refer to each by its 0-based index when editing):");
    d.beats.forEach((b, i) => {
      const purpose = b.purpose ? ` [${b.purpose}]` : "";
      out.push(`     beat ${i} · ${b.tStart}–${b.tEnd}s${purpose}: ${b.line || "(no line yet)"}`);
    });
  }
  if (d.visuals.length) {
    out.push(`   on-screen visuals: ${d.visuals.join("; ")}.`);
  }
  if (d.script && d.beats.length === 0) {
    // No structured beats — fall back to the raw script so Nova still has the words.
    out.push(`   script: ${truncate(d.script, 800)}`);
  }

  // The exemplar reels this draft was scripted from, with their teardowns — the
  // same grounding the scripter had. Lets the refiner justify changes from the
  // real reels ("@raycfu's winner opens on a cut, yours buries it").
  const insp = d.inspirations && d.inspirations.length ? d.inspirations : null;
  if (insp) {
    out.push("   modeled on these reels (your teardowns — ground changes in them):");
    for (const c of insp.slice(0, 4)) {
      const reach = c.reachMultiple !== null ? `, ${c.reachMultiple.toFixed(1)}× views/followers` : "";
      const hook = c.hook ? ` hook: "${truncate(c.hook, 120)}";` : "";
      const why = c.whyItWorked ? ` why it worked: ${truncate(c.whyItWorked, 240)}` : "";
      out.push(`     – @${c.handle} (${formatViewCount(c.views)} views${reach});${hook}${why}`);
    }
  } else if (d.inspiredBy.length) {
    out.push(`   modeled on: ${d.inspiredBy.map((h) => `@${h}`).join(", ")}.`);
  }

  if (d.voice) {
    out.push(`   the operator's own voice (match this substance + tone): ${truncate(d.voice, 400)}`);
  }
  return out.join("\n");
}

/** Trim long text for the prompt without cutting mid-escape. */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Compact view count for the snapshot — 1.2M / 48K / 920. */
function formatViewCount(n: number | null): string {
  if (n === null) return "unknown";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

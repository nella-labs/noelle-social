"use client";

import { useMemo, useState, useTransition } from "react";
import { AppLink as Link } from "@/components/nav/AppLink";
import { Avatar } from "@/components/constellation/Avatar";
import type { PostIdeaRow } from "@/lib/posts-queries";
import type { VideoIdeaRow } from "@/lib/video-studio-queries";
import { triggerIdeation, generatePost, dismissPost, addManualIdea } from "@/app/app/[orgSlug]/approvals/posts/actions";
import { LANE_BY_ID } from "./content-lanes";
import { InspirationRefs } from "./InspirationRefs";
import { IdeasGenerateBar, IdeasFilterBar, IdeasGrid } from "./ideas-board-shell";
import { VideoIdeasStudio } from "./VideoIdeasStudio";
import styles from "./ideas.module.css";

// The Ideas board shows ONLY ideas you still have to triage (status='proposed').
// The moment you hit Draft, the card is in-flight or done — it leaves this list
// and lives on the Drafts studio. A toolbar generates ideas; search + category
// pills keep a big board manageable; each card can fan out to its surfaces.
//
// One board, every lane: the standard post board (text) and Nova's video board
// share the generate bar + filter + grid (./ideas-board-shell); only the idea
// card body + the generate actions differ. The page renders ONE <IdeasPanel>;
// `lane="video"` delegates to VideoIdeasStudio (the video body, same shell).

const platLabel = (p: string) => (p === "x" ? "X" : p === "linkedin" ? "LinkedIn" : p === "reddit" ? "Reddit" : p === "video" ? "Video" : p);

export function IdeasPanel(
  props:
    | ({ lane?: "text" } & { orgSlug: string; ideas: PostIdeaRow[]; platform?: string | null })
    | { lane: "video"; orgSlug: string; ideas: VideoIdeaRow[] },
) {
  if (props.lane === "video") {
    return <VideoIdeasStudio orgSlug={props.orgSlug} ideas={props.ideas} />;
  }
  return <TextIdeasBoard orgSlug={props.orgSlug} ideas={props.ideas} platform={props.platform} />;
}

function TextIdeasBoard({
  orgSlug,
  ideas,
  platform = null,
}: {
  orgSlug: string;
  ideas: PostIdeaRow[];
  /** Selected workspace platform (null = All). Ideas are cross-platform: an
   * idea generated here fans out into an X variant + a LinkedIn variant. Reddit
   * is view-only (Orion drafts replies, not original posts). */
  platform?: string | null;
}) {
  const canGenerate = platform !== "reddit";
  const draftsHref = platform
    ? `/app/${orgSlug}/content?platform=${platform}&board=drafts`
    : `/app/${orgSlug}/content?board=drafts`;
  const laneAgent = platform ? LANE_BY_ID[platform]?.agent : null;

  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [count, setCount] = useState(3);
  const [own, setOwn] = useState("");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");

  // Only proposed ideas belong here; generating/drafted/ready moved to Drafts.
  const proposed = useMemo(() => ideas.filter((i) => i.status === "proposed"), [ideas]);
  const inFlight = ideas.filter((i) => i.status === "approved" || i.status === "drafting").length;
  const doneish = ideas.filter((i) => i.status === "drafted" || i.status === "ready").length;

  const cats = useMemo(
    () => ["all", ...[...new Set(proposed.map((i) => i.pillar).filter((p): p is string => Boolean(p)))].sort()],
    [proposed],
  );

  const visible = useMemo(() => {
    const rows = proposed.filter(
      (i) =>
        (cat === "all" || i.pillar === cat) &&
        (!q || (i.hook + " " + (i.thesis ?? "")).toLowerCase().includes(q.toLowerCase())),
    );
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return rows;
  }, [proposed, cat, q]);

  // The lane scopes ideation: x → Vega (X-only ideas), linkedin → Lyra
  // (linkedin-only), All (null) → Lyra + the linkedin+x fan-out. reddit can't
  // generate (canGenerate guards it), so it never reaches here.
  const lanePlatform = platform === "x" || platform === "linkedin" ? platform : undefined;

  function ideate(mode: "single" | "batch") {
    setMsg(null);
    startTransition(async () => {
      const res = await triggerIdeation({ orgSlug, mode, count: mode === "single" ? count : undefined, platform: lanePlatform });
      setMsg(
        res.ok
          ? mode === "batch"
            ? "Weekly batch requested — 7 ideas will appear shortly (one per day)."
            : `Requested ${count} idea${count === 1 ? "" : "s"} — they'll appear shortly.`
          : `Couldn't request ideas: ${res.error.message}`,
      );
    });
  }

  function addOwn() {
    const hook = own.trim();
    if (!hook) return;
    setMsg(null);
    startTransition(async () => {
      const res = await addManualIdea({ orgSlug, hook, platform: lanePlatform });
      if (!res.ok) {
        setMsg(`Couldn't add idea: ${res.error.message}`);
        return;
      }
      const gen = await generatePost({ orgSlug, ideaId: res.ideaId });
      setOwn("");
      setMsg(gen.ok ? "Your idea was added — drafting the post now." : `Idea added, but couldn't draft: ${gen.error.message}`);
    });
  }

  function generate(ideaId: string) {
    setBusyId(ideaId);
    setMsg(null);
    startTransition(async () => {
      const res = await generatePost({ orgSlug, ideaId });
      if (!res.ok) setMsg(`Couldn't draft: ${res.error.message}`);
      setBusyId(null);
    });
  }

  function dismiss(id: string) {
    setBusyId(id);
    startTransition(async () => {
      const res = await dismissPost({ orgSlug, id, target: "idea" });
      if (!res.ok) setMsg(`Couldn't dismiss: ${res.error.message}`);
      setBusyId(null);
    });
  }

  if (!canGenerate) {
    return (
      <div className="card" style={{ textAlign: "center", padding: 36 }}>
        <p className="serif" style={{ fontSize: 22, margin: 0 }}>Reddit posts are view-only here.</p>
        <p style={{ color: "var(--ink-muted)", fontSize: 13, maxWidth: "60ch", margin: "10px auto 0" }}>
          Orion drafts Reddit <em>replies</em>, not original posts, so there&apos;s no in-app generation
          for Reddit. To generate original posts, switch to <strong>All</strong>, <strong>X</strong>, or{" "}
          <strong>LinkedIn</strong> — one idea fans out into both an X and a LinkedIn variant.
        </p>
      </div>
    );
  }

  return (
    <div>
      <IdeasGenerateBar
        eyebrow={`Generate ideas${laneAgent ? ` · ${laneAgent}` : ""}`}
        description="Research-backed hooks, grounded in your vault voice and what performs. Pick a count."
        count={count}
        setCount={setCount}
        onGenerate={() => ideate("single")}
        onBatch={() => ideate("batch")}
        genBusy={pending}
        own={own}
        setOwn={setOwn}
        onAddOwn={addOwn}
        ownPlaceholder="Seed a hook in your own words — turned into finished posts in your voice…"
        ownBusy={pending}
      />

      {msg && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--ink-muted)", marginBottom: 12 }}>{msg}</div>
      )}

      {/* In-flight / done ideas live on the Drafts board, not here. */}
      {(inFlight > 0 || doneish > 0) && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-muted)", marginBottom: 14 }}>
          {inFlight > 0 && <span>{inFlight} generating</span>}
          {inFlight > 0 && doneish > 0 && <span> · </span>}
          {doneish > 0 && <span>{doneish} drafted</span>}
          <Link href={draftsHref} style={{ color: "var(--accent)", marginLeft: 8 }}>→ Drafts</Link>
        </div>
      )}

      {proposed.length > 1 && <IdeasFilterBar q={q} setQ={setQ} cat={cat} setCat={setCat} cats={cats} />}

      {/* Cards */}
      {proposed.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 36 }}>
          <p className="serif" style={{ fontSize: 22, margin: 0 }}>{inFlight + doneish > 0 ? "No ideas to triage." : "No post ideas yet."}</p>
          <p style={{ color: "var(--ink-muted)", fontSize: 13, maxWidth: "52ch", margin: "10px auto 0" }}>
            {inFlight + doneish > 0 ? (
              <>Everything you generated is on the <Link href={draftsHref} style={{ color: "var(--accent)" }}>Drafts studio</Link>. Generate more above.</>
            ) : (
              <>Hit <strong>Generate</strong> and Lyra researches your watchlist&apos;s best posts, fresh keyword finds, and your voice to propose hooks.</>
            )}
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 28, color: "var(--ink-muted)" }}>No ideas match these filters.</div>
      ) : (
        <IdeasGrid>
          {visible.map((idea) => (

"use client";

import styles from "./ideas.module.css";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AppLink as Link } from "@/components/nav/AppLink";
import type { VideoIdeaRow } from "@/lib/video-studio-queries";
import {
  generateVideoIdeas,
  getIdeationStatus,
  manualVideoIdea,
  approveVideoIdea,
  scheduleVideoIdea,
  dismissStudioItem,
} from "@/app/app/[orgSlug]/studio/actions";
import { InspirationStrip } from "./InspirationStrip";
import { IdeasGenerateBar, IdeasFilterBar, IdeasGrid } from "./ideas-board-shell";

// Nova's Ideas board — the video body of the shared <IdeasPanel>. It renders the
// SAME generate bar + filter + grid (./ideas-board-shell) as the post board, so
// it's the same board as the other lanes, not a parallel copy. Tailored for
// video: each card shows the inspiration reels + reach, "Generate draft" sends
// it to the scripter, and ideation runs on a polled worker (the post board fires
// and forgets). Only proposed ideas triage here; approved/drafting live on Drafts.

const NOVA_ACCENT = "oklch(0.58 0.13 305)";
// Ideation runs on a polled worker; the panel watches the request flag instead
// of stranding a static "refresh in a moment" banner.
const POLL_MS = 4000;
const MAX_POLL_MS = 150_000;

export function VideoIdeasStudio({
  orgSlug,
  ideas,
}: {
  orgSlug: string;
  ideas: VideoIdeaRow[];
}) {
  const draftsHref = `/app/${orgSlug}/content?platform=video&board=drafts`;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [count, setCount] = useState(5);
  const [own, setOwn] = useState("");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stop polling if the panel unmounts mid-run.
  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  const proposed = useMemo(() => ideas.filter((i) => i.status === "proposed"), [ideas]);
  const inFlight = ideas.filter((i) => i.status === "approved" || i.status === "drafting").length;

  const cats = useMemo(
    () => ["all", ...[...new Set(proposed.map((i) => i.pillar).filter((p): p is string => Boolean(p)))].sort()],
    [proposed],
  );
  const visible = useMemo(() => {
    return proposed.filter((i) => {
      if (cat !== "all" && i.pillar !== cat) return false;
      if (q) {
        const hay = (i.hook + " " + (i.concept ?? "") + " " + (i.angle ?? "")).toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [proposed, cat, q]);

  const run = (fn: () => Promise<{ ok: boolean }>, note: string, id?: string, confirmed?: () => void) =>
    startTransition(async () => {
      setMsg(null);
      if (id) setBusyId(id);
      try {
        const result = await fn();
        if (!result.ok) return setMsg("Something went wrong — try again.");
        confirmed?.();
        setMsg(note);
      } catch {
        setMsg("Could not confirm the change — try again.");
      } finally {
        if (id) setBusyId((current) => current === id ? null : current);
      }
    });

  const finishGen = (note: string) => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
    setGenerating(false);
    setMsg(note);
  };

  // Poll the request flag until the worker clears it, then refresh + report
  // whether new ideas actually landed. `baseline` is the proposed count at
  // dispatch so we can tell "new ideas" from "ran but produced none".
  const pollIdeation = (baseline: number, label: string) => {
    let elapsed = 0;
    const tick = async () => {
      const s = await getIdeationStatus({ orgSlug });
      if (!s.ok) return finishGen("Something went wrong — try again.");
      if (!s.pending) {
        router.refresh();
        if (s.proposed > baseline) {
          const n = s.proposed - baseline;
          return finishGen(`✓ ${n} new ${n === 1 ? "idea" : "ideas"} ready.`);
        }
        return finishGen("Nova didn't surface a new idea this round — try again.");
      }
      elapsed += POLL_MS;
      if (elapsed >= MAX_POLL_MS) return finishGen(`${label} is taking a while — refresh in a moment.`);
      pollRef.current = setTimeout(tick, POLL_MS);
    };
    pollRef.current = setTimeout(tick, POLL_MS);
  };

  const ideate = (mode: "single" | "batch") => {
    setMsg(null);
    const label = mode === "single" ? `Generating ${count} idea${count === 1 ? "" : "s"}` : "Generating a weekly batch";
    const baseline = proposed.length;
    startTransition(async () => {
      const r = await generateVideoIdeas({ orgSlug, mode, count: mode === "single" ? count : undefined });
      if (!r.ok) return setMsg("Something went wrong — try again.");
      setGenerating(true);
      setMsg(`${label}…`);
      pollIdeation(baseline, label);
    });
  };
  const addOwn = () => {
    const submitted = own;
    const hook = submitted.trim();
    if (!hook) return;
    run(() => manualVideoIdea({ orgSlug, hook }), "✓ Idea added. Choose Generate draft when you're ready.", undefined,
      () => setOwn((current) => current === submitted ? "" : current));
  };
  const approve = (id: string) => run(() => approveVideoIdea({ orgSlug, ideaId: id }), "✓ Draft requested.", id);
  const schedule = (id: string, day: string | null) =>
    run(() => scheduleVideoIdea({ orgSlug, ideaId: id, day }), "✓ Schedule saved.", id);
  const dismiss = (id: string) => run(() => dismissStudioItem({ orgSlug, target: "idea", id }), "✓ Idea dismissed.", id);

  return (
    <div>
      <IdeasGenerateBar
        eyebrow="Generate ideas · Nova"
        description="Short-form hooks grounded on your Brand Guide + the creators you watch. Pick a count."
        count={count}
        setCount={setCount}
        onGenerate={() => ideate("single")}
        onBatch={() => ideate("batch")}
        genBusy={pending || generating}
        own={own}
        setOwn={setOwn}
        onAddOwn={addOwn}
        ownPlaceholder="Write a video idea to review before generating a draft…"
        ownBusy={pending}
        ownActionLabel="Add idea"
      />

      {msg ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--ink-muted)", marginBottom: 12 }}>
          {generating ? (
            <span
              aria-hidden
              style={{ width: 10, height: 10, borderRadius: "50%", border: `1.5px solid color-mix(in oklch, ${NOVA_ACCENT} 40%, var(--rule))`,
                       borderTopColor: NOVA_ACCENT, display: "inline-block", animation: "spin 0.7s linear infinite" }}
            />
          ) : null}
          <span>{msg}</span>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      ) : null}

      {inFlight > 0 ? (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-muted)", marginBottom: 14 }}>
          {inFlight} drafting
          <Link href={draftsHref} style={{ color: "var(--accent)", marginLeft: 8 }}>→ Drafts</Link>
        </div>
      ) : null}

      {proposed.length > 1 ? <IdeasFilterBar q={q} setQ={setQ} cat={cat} setCat={setCat} cats={cats} /> : null}

      {/* Cards */}
      {proposed.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 36 }}>
          <p className="serif" style={{ fontSize: 22, margin: 0 }}>{inFlight > 0 ? "No ideas to triage." : "No video ideas yet."}</p>
          <p style={{ color: "var(--ink-muted)", fontSize: 13, maxWidth: "52ch", margin: "10px auto 0" }}>
            {inFlight > 0 ? (
              <>Everything you generated is on the <Link href={draftsHref} style={{ color: "var(--accent)" }}>Drafts studio</Link>. Generate more above.</>
            ) : (
              <>Hit <strong>Generate</strong> and Nova proposes hooks grounded on what actually performs for the creators you watch — or write your own above.</>
            )}
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 28, color: "var(--ink-muted)" }}>No ideas match these filters.</div>
      ) : (
        <IdeasGrid>
          {visible.map((idea) => (

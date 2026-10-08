"use client";

import { useState, useTransition } from "react";
import { generateVideoStill } from "./actions";

const ERRORS: Record<string, string> = {
  empty: "Type a prompt first.",
  no_key: "Image generation isn’t configured on this server.",
  generation_failed: "Couldn’t generate an image — try again or tweak the prompt.",
  forbidden: "Not allowed.",
  not_found: "Nova isn’t set up here.",
  unauthenticated: "Sign in again.",
};

/**
 * On-demand still / thumbnail / graphic-background generator for a video draft
 * (Imagen 4 via the API-key path that works on the Lima box). Assist-only: shows
 * the image inline + a download link; the operator saves it and drops it into
 * their own edit. Fail-open with a friendly message.
 */
export function StudioStillGenerator({ orgSlug, seedPrompt }: { orgSlug: string; seedPrompt?: string }) {
  const [prompt, setPrompt] = useState(seedPrompt ?? "");
  const [image, setImage] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run() {
    setMsg(null);
    start(async () => {
      const res = await generateVideoStill({ orgSlug, prompt });
      if (res.ok) setImage(res.dataUrl);
      else setMsg(ERRORS[res.error] ?? "Something went wrong.");
    });
  }

  return (
    <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
      <textarea
        className="input"
        rows={2}
        placeholder="Describe a still, thumbnail, or graphic background…"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        style={{ resize: "vertical", fontFamily: "inherit" }}
      />
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="btn btn-sm btn-accent"
          type="button"
          onClick={run}
          disabled={pending || !prompt.trim()}
        >
          {pending ? "Generating…" : "Generate still"}
        </button>
        {image ? (
          <a className="btn btn-sm btn-ghost" href={image} download="nova-still.png">
            Download
          </a>
        ) : null}
        {msg ? <span style={{ fontSize: 12, color: "var(--warn)" }}>{msg}</span> : null}
      </div>
      {image ? (
        // Raw <img>: `image` is a data:/blob: URL for a just-generated still, which
            // next/image cannot optimise.
        <img
          src={image}
          alt="Generated still"
          style={{
            width: 180,
            aspectRatio: "9 / 16",
            objectFit: "cover",
            borderRadius: 8,
            border: "1px solid var(--rule-soft)",
          }}
        />
      ) : null}
    </div>
  );
}

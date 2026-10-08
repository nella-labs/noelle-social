"use client";

import { useState } from "react";
import { AgentChat } from "@/components/agent-panels/AgentChat";

/**
 * "Talk to Nova" — opens the same context-aware AgentChat the agent detail page
 * uses, but inside the Content Video lane so you can brief Nova on a video idea,
 * ask for visual/graph directions, and shape scripts without leaving the studio.
 * The chat is grounded on Nova's Brand Guide + top harvested clips (the
 * video_intern context loader), so its suggestions reflect what's performing.
 */
export function NovaChatToggle({ instanceId, orgSlug }: { instanceId: string; orgSlug: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 16 }}>
      <button
        type="button"
        className={`btn btn-sm${open ? " btn-primary" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        💬 Talk to Nova {open ? "▾" : "▸"}
      </button>
      {open ? (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="card-h">
            <h3>Talk to Nova</h3>
            <span className="tag">grounded on your Brand Guide + top clips</span>
          </div>
          <AgentChat
            agentId="video_intern"
            agentRole="video-editor"
            agentName="Nova"
            instanceId={instanceId}
            orgSlug={orgSlug}
          />
        </div>
      ) : null}
    </div>
  );
}

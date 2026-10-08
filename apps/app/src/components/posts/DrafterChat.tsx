"use client";

import { useState, useTransition } from "react";
import type { DrafterNoteRow } from "@/lib/posts-queries";
import { sendPostChat } from "@/app/app/[orgSlug]/approvals/posts/actions";

// The mini drafter chat: talk to the post-drafter to tailor a post. Give
// framing, a personal anecdote, things to avoid → the post regenerates with
// your guidance. Tick "Save as a standing rule" to apply it to every future
// post too. The agent's "reply" is the regenerated draft (it lands on the
// Drafts board / above this panel shortly after).
export function DrafterChat({
  orgSlug,
  ideaId,
  notes,
}: {
  orgSlug: string;
  ideaId: string;
  notes: DrafterNoteRow[];
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [pin, setPin] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  function send() {
    const text = message.trim();
    if (!text) return;
    setStatus(null);
    startTransition(async () => {
      const res = await sendPostChat({ orgSlug, ideaId, message: text, pin });
      if (res.ok) {
        setMessage("");
        setStatus(
          pin
            ? "Pinned as a standing rule. Regenerating this post…"
            : "Got it — regenerating this post with your note…",
        );
        setPin(false);
      } else {
        setStatus(`Couldn't send: ${res.error.message}`);
      }
    });
  }

  return (
    <div className="drafter-chat clay">
      <span className="eyebrow">Talk to the drafter</span>
      <ul className="chat-thread">
        {notes.length === 0 && (
          <li className="chat-empty ink-muted">
            Tell the drafter how to shape this post — a frame, a personal anecdote, what to avoid.
          </li>
        )}
        {notes.map((n) => (
          <li key={n.id} className={`chat-turn chat-turn--${n.role}`}>
            <span className="chat-role mono">{n.role === "operator" ? "you" : "lyra"}</span>
            <p className="chat-body">{n.body}</p>
            {n.pinned && <span className="chat-pinned mono">pinned rule</span>}
          </li>
        ))}
      </ul>

      <textarea
        className="chat-input input"
        placeholder="e.g. open with the time I shipped at 3am; don't mention pricing; keep it dry and funny"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
        }}
      />
      <div className="chat-actions action-bar-phone">
        <label className="chat-pin">
          <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} />
          <span>Save as a standing rule</span>
        </label>
        <button className="btn btn-primary btn-sm" onClick={send} disabled={pending || !message.trim()}>
          {pending ? "Sending…" : "Send & regenerate"}
        </button>
      </div>
      {status && <span className="ideas-msg mono">{status}</span>}
    </div>
  );
}

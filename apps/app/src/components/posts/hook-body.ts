// Hook ⇄ body helpers shared by the drafts editor and its live preview.
//
// The drafter bakes the chosen hook into body's first line AND surfaces it in the
// HOOK field. `body` stays the full post (that's what gets posted); these helpers
// let the editor + preview show the hook and the rest separately without printing
// it twice. stripLeadingHook ∘ joinHook round-trips.

// body minus its leading hook line, so the editor's Content box doesn't repeat the
// hook. Returns body unchanged when it doesn't start with the hook.
export function stripLeadingHook(body: string, hook: string | null | undefined): string {
  const h = (hook ?? "").trim();
  if (!h) return body;
  const lead = body.replace(/^\s+/, "");
  return lead.startsWith(h) ? lead.slice(h.length).replace(/^\s+/, "") : body;
}

// The stored hook is body's first non-empty line, trimmed and capped. Mirrors how
// the drafter derives draft_hook server-side (firstLineHook in post-drafter-tick),
// so an unedited X post — whose whole ≤280 body IS its one line — round-trips to the
// same hook and never triggers a spurious rewrite on save.
export function hookFromBody(body: string): string {
  const line = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > 300 ? line.slice(0, 300) : line;
}

// hook line + content → the full post body (what actually gets posted/stored).
export function joinHook(hook: string, content: string): string {
  const h = hook.trim();
  if (!h) return content;
  return content.trim() ? `${h}\n\n${content}` : h;
}

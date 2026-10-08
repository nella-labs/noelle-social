/** An explicit invalid edit is withheld rather than replaced with older text. */
export function readDraftBody(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const values = payload as { edited_body?: unknown; body?: unknown };
  const body = values.edited_body ?? values.body;
  return typeof body === "string" ? body.trim() : "";
}

/** Creating a reply through MCP is not consent for an unattended send. */
export function awaitingHumanReview(payload: {
  human_review_required?: boolean;
  human_send_approved?: boolean;
} | null): boolean {
  return payload?.human_review_required === true && payload.human_send_approved !== true;
}

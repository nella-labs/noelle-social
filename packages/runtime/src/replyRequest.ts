export interface ReplyRequestMeta {
  requestKey: string;
  instructions: string | null;
  humanReviewRequired: true;
}

/** Read the durable operator request carried by a saved lead. */
export function readReplyRequest(payload: Record<string, unknown>): ReplyRequestMeta | null {
  if (payload.reply_requested === false) return null;
  const raw = payload.reply_request;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const request = raw as Record<string, unknown>;
  const requestKey = typeof request.request_key === "string" ? request.request_key : null;
  if (!requestKey || requestKey.length > 200) return null;
  return {
    requestKey,
    instructions: typeof request.instructions === "string" ? request.instructions : null,
    humanReviewRequired: true,
  };
}

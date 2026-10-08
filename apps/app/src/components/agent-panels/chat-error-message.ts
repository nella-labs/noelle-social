/**
 * The chat panel and the agent *worker* are independent. The worker may be
 * happily processing approvals while the chat-LLM call fails (Bedrock auth,
 * model access, network blip). Pick a message that names the chat channel,
 * not the agent — saying "agent is offline" when the worker is fine confuses
 * the founder into thinking their queue is dead.
 *
 * Branches by the structured `error` discriminator from the chat route
 * (forbidden / not_found / model_unavailable / model_error / invalid_body)
 * and falls through to status-code-based copy for anything else.
 */
export function chatErrorMessage(opts: {
  status?: number;
  code?: string;
  agentName: string;
}): string {
  const { status, code, agentName } = opts;
  if (code === "forbidden" || status === 403) {
    return "You're not a member of this org — refresh or sign in again.";
  }
  if (code === "not_found" || status === 404) {
    return `${agentName} isn't provisioned in this org yet.`;
  }
  if (code === "model_unavailable" || status === 503) {
    return `${agentName}'s chat model isn't reachable right now. The agent's background work is unaffected. Try again in a moment.`;
  }
  if (code === "model_error" || status === 502) {
    return `${agentName}'s chat model returned an error. The agent's background work is unaffected. Try again in a moment.`;
  }
  if (code === "invalid_body" || code === "invalid_json" || status === 400) {
    return "That message couldn't be sent — try rephrasing.";
  }
  if (status && status >= 500) {
    return `Chat is temporarily unavailable (${status}). The agent's background work is unaffected.`;
  }
  return `Couldn't reach chat right now — the agent's background work is unaffected. Try again in a moment.`;
}

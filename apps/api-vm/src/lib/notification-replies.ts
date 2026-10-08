export function resolveNotificationMaxTurns(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return 2;
  const value = Math.floor(Number(trimmed));
  return Number.isSafeInteger(value) && value >= 0 ? value : 2;
}

export function conversationKeyFor(item: {
  author_handle: string; conversation?: { root_post_id?: string | null } | null;
}): string {
  const root = item.conversation?.root_post_id?.trim();
  return root ? `root:${root}` : `author:${item.author_handle.trim().replace(/^@+/, "").toLowerCase()}`;
}

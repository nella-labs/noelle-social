/** Whether a queued reply satisfies the actor-ready approval invariant. */
export function ReplyReadinessBadge({ ready, unavailable = false }: { ready: boolean; unavailable?: boolean }) {
  const queueError = unavailable || !ready;
  return (
    <span
      className={queueError ? "tag" : "tag tag-acc"}
      style={{ height: 18, fontSize: 10, letterSpacing: "0.04em" }}
      title={unavailable
        ? "The automatic review policy could not be loaded; this reply should not be pending"
        : ready
        ? "Automatic review passed; the actor still follows its send controls"
        : "This pending reply violates the actor-ready queue invariant"}
    >
      {queueError ? "Queue error" : "Approved"}
    </span>
  );
}

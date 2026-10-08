/** A wait only reads progress. It never retries or requeues the write operation. */
export async function pollUntil<T>(
  read: () => Promise<T>,
  complete: (value: T) => boolean,
  waitSeconds = 0,
): Promise<T> {
  const duration = Math.max(0, Math.min(45, Number.isNaN(waitSeconds) ? 0 : waitSeconds));
  const deadline = Date.now() + duration * 1_000;
  let value = await read();
  while (!complete(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, deadline - Date.now())));
    value = await read();
  }
  return value;
}

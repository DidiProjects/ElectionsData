/** Runs `worker` over `items` with at most `limit` calls in flight. */
export async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !signal?.aborted) {
      const item = items[next++] as T;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  let failure: unknown;
  async function worker(): Promise<void> {
    while (failure === undefined) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failure = error;
        return;
      }
    }
  }
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failure !== undefined) {
    throw failure;
  }
  return results;
}

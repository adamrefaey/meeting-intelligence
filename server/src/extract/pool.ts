/**
 * Run `fn` over `items` in batches of `concurrency`. Results stay in input
 * order. A rejection skips later batches; sibling promises in the failed
 * batch are not awaited.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(concurrency, 1);
  const results: R[] = [];

  for (let start = 0; start < items.length; start += limit) {
    const batch = items.slice(start, start + limit);
    const batchResults = await Promise.all(
      // async: a sync throw becomes a rejection Promise.all already tracks
      batch.map(async (item, offset) => fn(item, start + offset)),
    );
    results.push(...batchResults);
  }

  return results;
}

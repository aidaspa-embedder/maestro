/** Order-preserving worker pool; bounds network, git and filesystem load. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, limit)) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await task(items[i]!, i);
    }
  }));
  return results;
}

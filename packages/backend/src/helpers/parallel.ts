/**
 * Run async tasks with a fixed concurrency limit.
 */
export async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	if (items.length === 0) {
		return [];
	}

	const limit = Math.max(1, concurrency);
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (nextIndex < items.length) {
			const currentIndex = nextIndex++;
			results[currentIndex] = await fn(items[currentIndex], currentIndex);
		}
	});

	await Promise.all(workers);
	return results;
}

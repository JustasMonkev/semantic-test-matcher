// Use the global timer so callers' timer mocks also control retries and lock polling.
export async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Maps items with at most `limit` workers in flight. After a worker fails no new items
 * start; the first error is rethrown once the in-flight items have settled.
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    let failure: { error: unknown } | undefined;

    const workerCount = Math.max(1, Math.min(Math.floor(limit), items.length));
    const runners = Array.from({ length: workerCount }, async () => {
        while (!failure && nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            try {
                results[index] = await worker(items[index], index);
            } catch (error) {
                failure ??= { error };
            }
        }
    });

    await Promise.all(runners);
    if (failure) {
        throw failure.error;
    }
    return results;
}

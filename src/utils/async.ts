export async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    let firstFailure: { error: unknown } | undefined;

    const runWorker = async () => {
        while (!firstFailure && nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            try {
                results[index] = await worker(items[index], index);
            } catch (error) {
                firstFailure ??= { error };
            }
        }
    };

    const workerCount = Math.max(1, Math.min(Math.floor(limit), items.length));
    await Promise.all(Array.from({ length: workerCount }, runWorker));
    if (firstFailure) {
        throw firstFailure.error;
    }
    return results;
}

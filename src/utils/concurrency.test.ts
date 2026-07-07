import test from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from './concurrency.ts';

test('preserves input order in results', async () => {
    const items = [30, 10, 20, 5];
    const results = await mapWithConcurrency(items, 4, async (item) => {
        await new Promise((resolve) => setTimeout(resolve, item));
        return item * 2;
    });
    assert.deepEqual(results, [60, 20, 40, 10]);
});

test('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
    });
    assert.ok(peak <= 3, `peak concurrency was ${peak}`);
});

test('handles empty input and rejects on worker failure', async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async (x) => x), []);
    await assert.rejects(
        mapWithConcurrency([1, 2, 3], 2, async (item) => {
            if (item === 2) {
                throw new Error('boom');
            }
            return item;
        }),
        /boom/
    );
});

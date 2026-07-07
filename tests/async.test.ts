import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { mapWithConcurrency } from '../src/utils/async.ts';

describe('mapWithConcurrency', () => {
    it('preserves input order in the results', async () => {
        const items = [30, 5, 20, 1, 10];
        const results = await mapWithConcurrency(items, 3, async (value) => {
            await delay(value);
            return value * 2;
        });
        assert.deepEqual(results, [60, 10, 40, 2, 20]);
    });

    it('never runs more workers than the limit', async () => {
        let active = 0;
        let peak = 0;
        await mapWithConcurrency(Array.from({ length: 20 }, (_, index) => index), 4, async () => {
            active += 1;
            peak = Math.max(peak, active);
            await delay(5);
            active -= 1;
        });
        assert.ok(peak <= 4, `peak concurrency was ${peak}`);
        assert.ok(peak > 1, 'expected some parallelism');
    });

    it('handles an empty input', async () => {
        assert.deepEqual(await mapWithConcurrency([], 8, async () => 1), []);
    });

    it('propagates worker errors', async () => {
        await assert.rejects(
            mapWithConcurrency([1, 2, 3], 2, async (value) => {
                if (value === 2) {
                    throw new Error('boom');
                }
                return value;
            }),
            /boom/
        );
    });
});

import pMap from 'p-map';
import pLimit from 'p-limit';
import { mapWithConcurrency } from '../src/utils/async.ts';
import { measure, report, section } from './harness.mjs';

const CONCURRENCY = 8; // EMBED_CONCURRENCY in src/commands/match.ts and benchmark.ts

async function pLimitMap(items, limit, worker) {
    const limiter = pLimit(limit);
    return Promise.all(items.map((item, index) => limiter(() => worker(item, index))));
}

async function run(label, itemCount, worker, { samples = 11 } = {}) {
    const items = Array.from({ length: itemCount }, (unused, index) => index);

    const custom = await measure(() => mapWithConcurrency(items, CONCURRENCY, worker), { samples, innerOps: itemCount });
    const mapped = await measure(() => pMap(items, worker, { concurrency: CONCURRENCY }), { samples, innerOps: itemCount });
    const limited = await measure(() => pLimitMap(items, CONCURRENCY, worker), { samples, innerOps: itemCount });

    return report(label, [
        { name: 'custom (async.ts)', baseline: true, ...custom },
        { name: 'p-map', ...mapped },
        { name: 'p-limit', ...limited },
    ], { unit: 'task' });
}

section('BOUNDED CONCURRENCY — scheduler overhead (concurrency 8)');

// Pure scheduling overhead: the task itself does nothing.
await run('1,000 no-op async tasks', 1000, async (item) => item * 2);

// Realistic shape: candidate embedding work is I/O + native inference bound.
const spin = (ms) => {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) { /* busy */ }
};
await run('200 tasks x ~1 ms of work', 200, async (item) => { spin(1); return item; }, { samples: 7 });

section('BOUNDED CONCURRENCY — semantics on failure');
const failing = async (item) => {
    if (item === 2) throw new Error('boom');
    await new Promise((resolve) => setTimeout(resolve, 5));
    return item;
};

for (const [name, impl] of [
    ['custom (async.ts)', (items) => mapWithConcurrency(items, 2, failing)],
    ['p-map', (items) => pMap(items, failing, { concurrency: 2 })],
]) {
    let started = 0;
    const counted = async (item) => { started += 1; return failing(item); };
    try {
        await (name === 'p-map'
            ? pMap([0, 1, 2, 3, 4, 5, 6, 7], counted, { concurrency: 2 })
            : mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 2, counted));
        console.log(`  ${name.padEnd(18)} resolved (unexpected)`);
    } catch (error) {
        // Give any still-running workers a tick to keep consuming the queue.
        await new Promise((resolve) => setTimeout(resolve, 60));
        console.log(`  ${name.padEnd(18)} rejected "${error.message}"; tasks started after the failure: ${started} of 8`);
    }
}

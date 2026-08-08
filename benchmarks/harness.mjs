// Minimal benchmark harness: warmup, repeated timed samples, median + MAD.
const NS = 1_000_000_000n;

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdev(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
}

export async function measure(fn, { warmup = 5, samples = 15, innerOps = 1 } = {}) {
    for (let i = 0; i < warmup; i += 1) await fn();

    const perOp = [];
    for (let i = 0; i < samples; i += 1) {
        if (global.gc) global.gc();
        const start = process.hrtime.bigint();
        await fn();
        const end = process.hrtime.bigint();
        perOp.push(Number(end - start) / innerOps);
    }

    const med = median(perOp);
    return {
        medianNs: med,
        stdevNs: stdev(perOp),
        opsPerSec: med > 0 ? NS_PER_SEC / med : Infinity,
    };
}

const NS_PER_SEC = 1_000_000_000;

export function formatNs(ns) {
    if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
    if (ns >= 1_000) return `${(ns / 1_000).toFixed(2)} µs`;
    return `${ns.toFixed(0)} ns`;
}

export function report(title, results, { unit = 'op' } = {}) {
    const baseline = results.find((entry) => entry.baseline) ?? results[0];
    const nameWidth = Math.max(...results.map((entry) => entry.name.length), 12);

    console.log(`\n### ${title}`);
    console.log(
        `${'implementation'.padEnd(nameWidth)}  ${'median/'.concat(unit).padStart(12)}  ${'ops/sec'.padStart(12)}  ${'vs custom'.padStart(10)}  ${'rsd'.padStart(6)}`
    );
    console.log('-'.repeat(nameWidth + 48));
    for (const entry of results) {
        const ratio = baseline.medianNs / entry.medianNs;
        const rsd = entry.medianNs > 0 ? (entry.stdevNs / entry.medianNs) * 100 : 0;
        const label = ratio >= 1 ? `${ratio.toFixed(2)}x faster` : `${(1 / ratio).toFixed(2)}x slower`;
        console.log(
            `${entry.name.padEnd(nameWidth)}  ${formatNs(entry.medianNs).padStart(12)}  ${Math.round(entry.opsPerSec).toLocaleString('en-US').padStart(12)}  ${(entry.baseline ? '—' : label).padStart(10)}  ${`${rsd.toFixed(1)}%`.padStart(6)}`
        );
    }
    return results;
}

export function section(title) {
    console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

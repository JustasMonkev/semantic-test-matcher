import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import lockfile from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';
import {
    buildCacheKey,
    loadCache,
    persistCache,
    writeCachedEmbeddings,
} from '../src/services/cache.ts';
import { measure, report, section } from './harness.mjs';

const WORK = path.join(os.tmpdir(), 'rbt-cache-bench');
const DIMENSIONS = 768; // embeddinggemma-300M output width

function makeEntries(count) {
    const entries = {};
    for (let i = 0; i < count; i += 1) {
        const vector = Array.from({ length: DIMENSIONS }, (unused, d) => Math.sin(i + d) / 2);
        entries[buildCacheKey('local', 'model.gguf', `document ${i}`)] = {
            createdAt: '2026-01-01T00:00:00.000Z',
            provider: 'local',
            model: 'model.gguf',
            vector,
            backend: 'gguf',
        };
    }
    return entries;
}

// ------------------------------------------- library-based equivalent path ---
async function libWrite(filePath, entries) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // proper-lockfile locks an existing path, so ensure the target exists.
    await fs.writeFile(filePath, '{}', { flag: 'wx' }).catch(() => {});
    const release = await lockfile.lock(filePath, { retries: { retries: 20, minTimeout: 20, maxTimeout: 200 }, stale: 30_000 });
    try {
        const cache = await loadCache(filePath);
        Object.assign(cache, entries);
        await writeFileAtomic(filePath, JSON.stringify(cache, null, 2));
    } finally {
        await release();
    }
}

async function reset(file) {
    await fs.rm(WORK, { recursive: true, force: true });
    await fs.mkdir(WORK, { recursive: true });
    return path.join(WORK, file);
}

section('EMBEDDING CACHE — locked read-modify-write (single process)');

for (const existing of [50, 500, 2000]) {
    const seed = makeEntries(existing);
    const addition = makeEntries(1);

    const customFile = await reset('custom.json');
    await persistCache(customFile, seed);
    const custom = await measure(() => writeCachedEmbeddings(customFile, addition), { warmup: 2, samples: 7 });

    const libFile = await reset('lib.json');
    await persistCache(libFile, seed);
    const lib = await measure(() => libWrite(libFile, addition), { warmup: 2, samples: 7 });

    const bytes = (await fs.stat(libFile)).size;
    report(`append 1 entry to a cache of ${existing} (file ≈ ${(bytes / 1_000_000).toFixed(1)} MB)`, [
        { name: 'custom (cache.ts)', baseline: true, ...custom },
        { name: 'proper-lockfile + write-file-atomic', ...lib },
    ], { unit: 'write' });
}

section('EMBEDDING CACHE — where the time actually goes (2,000 entries)');
{
    const file = await reset('profile.json');
    const seed = makeEntries(2000);
    await persistCache(file, seed);
    const raw = await fs.readFile(file, 'utf8');

    const read = await measure(() => fs.readFile(file, 'utf8'), { samples: 9 });
    const parse = await measure(() => { JSON.parse(raw); }, { samples: 9 });
    const stringifyPretty = await measure(() => { JSON.stringify(seed, null, 2); }, { samples: 9 });
    const stringifyCompact = await measure(() => { JSON.stringify(seed); }, { samples: 9 });
    const write = await measure(() => fs.writeFile(path.join(WORK, 'out.tmp'), raw, 'utf8'), { samples: 9 });

    report('cost breakdown of one cache write', [
        { name: 'JSON.stringify(cache, null, 2)', baseline: true, ...stringifyPretty },
        { name: 'JSON.stringify(cache)', ...stringifyCompact },
        { name: 'JSON.parse(raw)', ...parse },
        { name: 'fs.readFile', ...read },
        { name: 'fs.writeFile', ...write },
    ], { unit: 'call' });
    console.log(`  pretty-printed size: ${(Buffer.byteLength(JSON.stringify(seed, null, 2)) / 1_000_000).toFixed(2)} MB`);
    console.log(`  compact size:        ${(Buffer.byteLength(JSON.stringify(seed)) / 1_000_000).toFixed(2)} MB`);
}

await fs.rm(WORK, { recursive: true, force: true });

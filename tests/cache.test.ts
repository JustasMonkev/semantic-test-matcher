import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCacheKey, loadCache, writeCacheEntries } from '../src/services/cache.ts';

interface Entry {
    value: number;
}

async function makeTempCacheFile(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-cache-'));
    return path.join(dir, 'cache.json');
}

describe('buildCacheKey', () => {
    it('normalizes whitespace so equivalent texts share a key', () => {
        assert.equal(
            buildCacheKey('typesafe', 'model', 'hello   world'),
            buildCacheKey('typesafe', 'model', ' hello\r\nworld ')
        );
    });

    it('separates keys by provider, model, and text', () => {
        const base = buildCacheKey('typesafe', 'model', 'text');
        assert.notEqual(buildCacheKey('other-backend', 'model', 'text'), base);
        assert.notEqual(buildCacheKey('typesafe', 'other', 'text'), base);
        assert.notEqual(buildCacheKey('typesafe', 'model', 'other'), base);
    });
});

describe('loadCache', () => {
    it('returns an empty cache for a missing file', async () => {
        assert.deepEqual(await loadCache<Entry>(await makeTempCacheFile()), {});
    });

    it('ignores a malformed cache file', async () => {
        const cacheFile = await makeTempCacheFile();
        await fs.writeFile(cacheFile, 'not json', 'utf8');
        assert.deepEqual(await loadCache<Entry>(cacheFile), {});
    });
});

describe('writeCacheEntries', () => {
    it('round-trips entries through the cache file', async () => {
        const cacheFile = await makeTempCacheFile();
        await writeCacheEntries<Entry>(cacheFile, { key: { value: 1 } });

        assert.deepEqual(await loadCache<Entry>(cacheFile), { key: { value: 1 } });
    });

    it('persists a batch in one write and merges with existing entries', async () => {
        const cacheFile = await makeTempCacheFile();
        await writeCacheEntries<Entry>(cacheFile, { existing: { value: 0 } });
        await writeCacheEntries<Entry>(cacheFile, { one: { value: 1 }, two: { value: 2 }, three: { value: 3 } });

        const cache = await loadCache<Entry>(cacheFile);
        assert.deepEqual(Object.keys(cache).sort(), ['existing', 'one', 'three', 'two']);
    });

    it('removes the lock file after a write', async () => {
        const cacheFile = await makeTempCacheFile();
        await writeCacheEntries<Entry>(cacheFile, { key: { value: 1 } });

        assert.deepEqual(await fs.readdir(path.dirname(cacheFile)), ['cache.json']);
    });

    it('does nothing for an empty batch', async () => {
        const cacheFile = await makeTempCacheFile();
        await writeCacheEntries<Entry>(cacheFile, {});
        await assert.rejects(fs.stat(cacheFile), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    });
});

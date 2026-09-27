import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCacheKey, loadCache, writeCacheEntries } from '../src/services/cache.ts';

interface Entry {
    value: number;
}

// Older than the 10 minutes after which a lock whose writer cannot be checked is taken over.
const ABANDONED_AGE_MS = 11 * 60_000;

async function makeTempCacheFile(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-cache-'));
    return path.join(dir, 'cache.json');
}

describe('buildCacheKey', () => {
    it('keeps whitespace significant, since it can be the change being scored', () => {
        assert.notEqual(buildCacheKey('typesafe', 'model', 'a  b'), buildCacheKey('typesafe', 'model', 'a b'));
        assert.equal(buildCacheKey('typesafe', 'model', 'a\r\nb'), buildCacheKey('typesafe', 'model', 'a\nb'));
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

    it('ignores a cache file whose JSON is not an object', async () => {
        const cacheFile = await makeTempCacheFile();
        for (const json of ['null', '[]', '42', '"text"']) {
            await fs.writeFile(cacheFile, json, 'utf8');
            assert.deepEqual(await loadCache<Entry>(cacheFile), {}, json);
        }
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

    it('waits for another writer to release the lock', async () => {
        const cacheFile = await makeTempCacheFile();
        const lockFile = path.join(path.dirname(cacheFile), 'cache.lock');
        await fs.writeFile(lockFile, 'other writer', 'utf8');

        const write = writeCacheEntries<Entry>(cacheFile, { key: { value: 1 } });
        // Several 20ms lock polls: long enough that a writer ignoring the lock would have written.
        const heldLockMs = 60;
        await new Promise((resolve) => setTimeout(resolve, heldLockMs));
        await assert.rejects(fs.stat(cacheFile), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');

        await fs.unlink(lockFile);
        await write;
        assert.deepEqual(await loadCache<Entry>(cacheFile), { key: { value: 1 } });
    });

    it('replaces an abandoned lock whose writer cannot be checked', async () => {
        const cacheFile = await makeTempCacheFile();
        const lockFile = path.join(path.dirname(cacheFile), 'cache.lock');
        await fs.writeFile(lockFile, 'crashed writer', 'utf8');
        const longAgo = new Date(Date.now() - ABANDONED_AGE_MS);
        await fs.utimes(lockFile, longAgo, longAgo);

        await writeCacheEntries<Entry>(cacheFile, { key: { value: 1 } });

        assert.deepEqual(await loadCache<Entry>(cacheFile), { key: { value: 1 } });
        assert.deepEqual(await fs.readdir(path.dirname(cacheFile)), ['cache.json']);
    });

    it('keeps a lock whose writer cannot be checked until it is abandoned', async () => {
        const cacheFile = await makeTempCacheFile();
        const lockFile = path.join(path.dirname(cacheFile), 'cache.lock');
        await fs.writeFile(lockFile, `12345\nanother-host\nremote-writer\n`, 'utf8');
        const longAgo = new Date(Date.now() - 60_000);
        await fs.utimes(lockFile, longAgo, longAgo);

        const write = writeCacheEntries<Entry>(cacheFile, { key: { value: 1 } });
        await new Promise((resolve) => setTimeout(resolve, 60));
        await assert.rejects(fs.stat(cacheFile), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');

        await fs.unlink(lockFile);
        await write;
        assert.deepEqual(await loadCache<Entry>(cacheFile), { key: { value: 1 } });
    });

    it('keeps an old lock while the writer that holds it is still running', async () => {
        const cacheFile = await makeTempCacheFile();
        const lockFile = path.join(path.dirname(cacheFile), 'cache.lock');
        await fs.writeFile(lockFile, `${process.pid}\n${os.hostname()}\nslow-writer\n`, 'utf8');
        const longAgo = new Date(Date.now() - 60_000);
        await fs.utimes(lockFile, longAgo, longAgo);

        const write = writeCacheEntries<Entry>(cacheFile, { key: { value: 1 } });
        await new Promise((resolve) => setTimeout(resolve, 60));
        await assert.rejects(fs.stat(cacheFile), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');

        await fs.unlink(lockFile);
        await write;
        assert.deepEqual(await loadCache<Entry>(cacheFile), { key: { value: 1 } });
    });

    it('replaces an old lock whose writer has exited', async () => {
        const cacheFile = await makeTempCacheFile();
        const lockFile = path.join(path.dirname(cacheFile), 'cache.lock');
        const exitedPid = spawnSync(process.execPath, ['-e', '']).pid;
        await fs.writeFile(lockFile, `${exitedPid}\n${os.hostname()}\nexited-writer\n`, 'utf8');
        const longAgo = new Date(Date.now() - 60_000);
        await fs.utimes(lockFile, longAgo, longAgo);

        await writeCacheEntries<Entry>(cacheFile, { key: { value: 1 } });

        assert.deepEqual(await fs.readdir(path.dirname(cacheFile)), ['cache.json']);
    });

    it('lets exactly one writer at a time take over a stale lock, so concurrent writes all persist', async () => {
        // The race is timing-dependent; several rounds made the previous removal lose entries reliably.
        for (let round = 0; round < 20; round += 1) {
            const cacheFile = await makeTempCacheFile();
            const lockFile = path.join(path.dirname(cacheFile), 'cache.lock');
            await fs.writeFile(lockFile, 'crashed writer', 'utf8');
            const longAgo = new Date(Date.now() - ABANDONED_AGE_MS);
            await fs.utimes(lockFile, longAgo, longAgo);

            await Promise.all(Array.from({ length: 8 }, (_, index) =>
                writeCacheEntries<Entry>(cacheFile, { [`key${index}`]: { value: index } })
            ));

            assert.equal(Object.keys(await loadCache<Entry>(cacheFile)).length, 8, `round ${round}`);
            assert.deepEqual(await fs.readdir(path.dirname(cacheFile)), ['cache.json']);
        }
    });

    it('clears a takeover lock left by a crash', async () => {
        const cacheFile = await makeTempCacheFile();
        const lockFile = path.join(path.dirname(cacheFile), 'cache.lock');
        const longAgo = new Date(Date.now() - ABANDONED_AGE_MS);
        for (const file of [lockFile, `${lockFile}.takeover`]) {
            await fs.writeFile(file, 'crashed writer', 'utf8');
            await fs.utimes(file, longAgo, longAgo);
        }

        await writeCacheEntries<Entry>(cacheFile, { key: { value: 1 } });

        assert.deepEqual(await fs.readdir(path.dirname(cacheFile)), ['cache.json']);
    });

    it('leaves a lock that another writer took over in place', async () => {
        const cacheFile = await makeTempCacheFile();
        const lockFile = path.join(path.dirname(cacheFile), 'cache.lock');
        process.env.RBT_CACHE_WRITE_DELAY_MS = '150';
        try {
            const write = writeCacheEntries<Entry>(cacheFile, { key: { value: 1 } });
            await new Promise((resolve) => setTimeout(resolve, 60));
            await fs.writeFile(lockFile, 'new owner', 'utf8');
            await write;
        } finally {
            delete process.env.RBT_CACHE_WRITE_DELAY_MS;
        }

        assert.equal(await fs.readFile(lockFile, 'utf8'), 'new owner');
    });

    it('does nothing for an empty batch', async () => {
        const cacheFile = await makeTempCacheFile();
        await writeCacheEntries<Entry>(cacheFile, {});
        await assert.rejects(fs.stat(cacheFile), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    });
});

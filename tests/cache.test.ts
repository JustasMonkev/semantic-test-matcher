import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    buildCacheKey,
    getCacheFile,
    loadCache,
    readCachedEmbedding,
    writeCachedEmbedding,
    writeCachedEmbeddings,
    type EmbeddingCache,
} from '../src/services/cache.ts';

async function makeTempCacheFile(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-cache-'));
    return getCacheFile(dir);
}

describe('buildCacheKey', () => {
    it('normalizes whitespace so equivalent texts share a key', () => {
        assert.equal(
            buildCacheKey('node-llama-cpp', 'model', 'hello   world'),
            buildCacheKey('node-llama-cpp', 'model', ' hello\r\nworld ')
        );
    });

    it('separates keys by provider, model, and text', () => {
        const base = buildCacheKey('node-llama-cpp', 'model', 'text');
        assert.notEqual(buildCacheKey('other-backend', 'model', 'text'), base);
        assert.notEqual(buildCacheKey('node-llama-cpp', 'other', 'text'), base);
        assert.notEqual(buildCacheKey('node-llama-cpp', 'model', 'other'), base);
    });
});

describe('loadCache', () => {
    it('returns an empty cache for a missing file', async () => {
        assert.deepEqual(await loadCache(await makeTempCacheFile()), {});
    });

    it('ignores a malformed cache file', async () => {
        const cacheFile = await makeTempCacheFile();
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, 'not json', 'utf8');
        assert.deepEqual(await loadCache(cacheFile), {});
    });
});

describe('writeCachedEmbedding / readCachedEmbedding', () => {
    it('round-trips an embedding through the cache file', async () => {
        const cacheFile = await makeTempCacheFile();
        await writeCachedEmbedding(cacheFile, 'node-llama-cpp', 'model', 'some text', [1, 2, 3], 'node-llama-cpp');

        const hit = await readCachedEmbedding(cacheFile, 'node-llama-cpp', 'model', 'some text');
        assert.ok(hit);
        assert.deepEqual(hit.vector, [1, 2, 3]);
        assert.equal(hit.backend, 'node-llama-cpp');
    });

    it('misses for a different model or text', async () => {
        const cacheFile = await makeTempCacheFile();
        await writeCachedEmbedding(cacheFile, 'node-llama-cpp', 'model', 'some text', [1], 'node-llama-cpp');

        assert.equal(await readCachedEmbedding(cacheFile, 'node-llama-cpp', 'other-model', 'some text'), null);
        assert.equal(await readCachedEmbedding(cacheFile, 'node-llama-cpp', 'model', 'other text'), null);
    });

    it('removes the lock file after a write', async () => {
        const cacheFile = await makeTempCacheFile();
        await writeCachedEmbedding(cacheFile, 'node-llama-cpp', 'model', 'text', [1], 'node-llama-cpp');

        const entries = await fs.readdir(path.dirname(cacheFile));
        assert.deepEqual(entries, ['embeddings.json']);
    });
});

describe('writeCachedEmbeddings', () => {
    it('persists a batch of entries in one write and merges with existing entries', async () => {
        const cacheFile = await makeTempCacheFile();
        await writeCachedEmbedding(cacheFile, 'node-llama-cpp', 'model', 'existing', [0], 'node-llama-cpp');

        const batch: EmbeddingCache = {};
        for (const text of ['one', 'two', 'three']) {
            batch[buildCacheKey('node-llama-cpp', 'model', text)] = {
                createdAt: new Date().toISOString(),
                provider: 'node-llama-cpp',
                model: 'model',
                vector: [1],
                backend: 'node-llama-cpp',
            };
        }
        await writeCachedEmbeddings(cacheFile, batch);

        const cache = await loadCache(cacheFile);
        assert.equal(Object.keys(cache).length, 4);
    });

    it('does nothing for an empty batch', async () => {
        const cacheFile = await makeTempCacheFile();
        await writeCachedEmbeddings(cacheFile, {});
        await assert.rejects(fs.stat(cacheFile), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    });
});

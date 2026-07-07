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
            buildCacheKey('hf', 'model', 'hello   world'),
            buildCacheKey('hf', 'model', ' hello\r\nworld ')
        );
    });

    it('separates keys by provider, model, and text', () => {
        const base = buildCacheKey('hf', 'model', 'text');
        assert.notEqual(buildCacheKey('ollama', 'model', 'text'), base);
        assert.notEqual(buildCacheKey('hf', 'other', 'text'), base);
        assert.notEqual(buildCacheKey('hf', 'model', 'other'), base);
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
        await writeCachedEmbedding(cacheFile, 'hf', 'model', 'some text', [1, 2, 3], 'hf');

        const hit = await readCachedEmbedding(cacheFile, 'hf', 'model', 'some text');
        assert.ok(hit);
        assert.deepEqual(hit.vector, [1, 2, 3]);
        assert.equal(hit.backend, 'hf');
    });

    it('misses for a different model or text', async () => {
        const cacheFile = await makeTempCacheFile();
        await writeCachedEmbedding(cacheFile, 'hf', 'model', 'some text', [1], 'hf');

        assert.equal(await readCachedEmbedding(cacheFile, 'hf', 'other-model', 'some text'), null);
        assert.equal(await readCachedEmbedding(cacheFile, 'hf', 'model', 'other text'), null);
    });

    it('removes the lock file after a write', async () => {
        const cacheFile = await makeTempCacheFile();
        await writeCachedEmbedding(cacheFile, 'hf', 'model', 'text', [1], 'hf');

        const entries = await fs.readdir(path.dirname(cacheFile));
        assert.deepEqual(entries, ['embeddings.json']);
    });
});

describe('writeCachedEmbeddings', () => {
    it('persists a batch of entries in one write and merges with existing entries', async () => {
        const cacheFile = await makeTempCacheFile();
        await writeCachedEmbedding(cacheFile, 'hf', 'model', 'existing', [0], 'hf');

        const batch: EmbeddingCache = {};
        for (const text of ['one', 'two', 'three']) {
            batch[buildCacheKey('hf', 'model', text)] = {
                createdAt: new Date().toISOString(),
                provider: 'hf',
                model: 'model',
                vector: [1],
                backend: 'hf',
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

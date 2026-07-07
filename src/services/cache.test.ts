import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EmbeddingCacheStore, getCacheFile, loadCache } from './cache.ts';

async function makeCacheDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'rbt-cache-test-'));
}

test('get returns entries written by set before flush', async () => {
    const cacheFile = getCacheFile(await makeCacheDir());
    const store = new EmbeddingCacheStore(cacheFile);

    assert.equal(await store.get('hf', 'model-a', 'hello'), null);
    store.set('hf', 'model-a', 'hello', [1, 2, 3], 'hf');

    const hit = await store.get('hf', 'model-a', 'hello');
    assert.deepEqual(hit?.vector, [1, 2, 3]);
    assert.equal(hit?.backend, 'hf');
});

test('flush persists entries once and is a no-op when clean', async () => {
    const cacheFile = getCacheFile(await makeCacheDir());
    const store = new EmbeddingCacheStore(cacheFile);

    await store.flush();
    await assert.rejects(fs.stat(cacheFile), { code: 'ENOENT' });

    store.set('hf', 'model-a', 'hello', [1, 2, 3], 'hf');
    store.set('hf', 'model-a', 'world', [4, 5, 6], 'hf');
    await store.flush();

    const onDisk = await loadCache(cacheFile);
    assert.equal(Object.keys(onDisk).length, 2);

    const reopened = new EmbeddingCacheStore(cacheFile);
    const hit = await reopened.get('hf', 'model-a', 'world');
    assert.deepEqual(hit?.vector, [4, 5, 6]);
});

test('flush merges with entries written by another process after load', async () => {
    const cacheFile = getCacheFile(await makeCacheDir());

    const first = new EmbeddingCacheStore(cacheFile);
    first.set('hf', 'model-a', 'from-first', [1], 'hf');

    // Force the store to load (empty) disk state before the other writer runs.
    await first.get('hf', 'model-a', 'anything');

    const other = new EmbeddingCacheStore(cacheFile);
    other.set('hf', 'model-a', 'from-other', [2], 'hf');
    await other.flush();

    await first.flush();

    const merged = new EmbeddingCacheStore(cacheFile);
    assert.deepEqual((await merged.get('hf', 'model-a', 'from-first'))?.vector, [1]);
    assert.deepEqual((await merged.get('hf', 'model-a', 'from-other'))?.vector, [2]);
});

test('malformed cache file is treated as empty instead of crashing', async () => {
    const cacheDir = await makeCacheDir();
    const cacheFile = getCacheFile(cacheDir);
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, '{not json', 'utf8');

    const store = new EmbeddingCacheStore(cacheFile);
    assert.equal(await store.get('hf', 'model-a', 'hello'), null);

    store.set('hf', 'model-a', 'hello', [7], 'hf');
    await store.flush();

    const recovered = await loadCache(cacheFile);
    assert.equal(Object.keys(recovered).length, 1);
});

test('cache key normalizes whitespace so formatting changes still hit', async () => {
    const cacheFile = getCacheFile(await makeCacheDir());
    const store = new EmbeddingCacheStore(cacheFile);

    store.set('hf', 'model-a', 'hello   world', [9], 'hf');
    const hit = await store.get('hf', 'model-a', 'hello\nworld');
    assert.deepEqual(hit?.vector, [9]);
});

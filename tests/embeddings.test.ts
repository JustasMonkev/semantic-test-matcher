import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmbedding, EmbeddingSession, getCacheEntryCount } from '../src/services/embeddings.ts';
import { getCacheFile, loadCache } from '../src/services/cache.ts';

// Stub mode keeps cache tests local and deterministic without loading a GGUF.
describe('EmbeddingSession (stub)', () => {
    let savedTestMode: string | undefined;
    let cacheDir: string;

    beforeEach(async () => {
        savedTestMode = process.env.RBT_EMBEDDING_TEST_MODE;
        process.env.RBT_EMBEDDING_TEST_MODE = 'stub';
        cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rbt-embed-'));
    });

    afterEach(() => {
        if (savedTestMode === undefined) {
            delete process.env.RBT_EMBEDDING_TEST_MODE;
        } else {
            process.env.RBT_EMBEDDING_TEST_MODE = savedTestMode;
        }
    });

    function makeSession(): EmbeddingSession {
        return new EmbeddingSession({
            model: 'stub-model',
            cacheDir,
        });
    }

    it('embeds text and reports a miss on first use', async () => {
        const session = makeSession();
        const result = await session.embed('checkout pricing logic');
        assert.equal(result.cacheHit, false);
        assert.equal(result.backend, 'node-llama-cpp');
        assert.ok(result.vector.length > 0);
    });

    it('serves repeated texts from memory within one session', async () => {
        const session = makeSession();
        const first = await session.embed('coupon validation');
        const second = await session.embed('coupon validation');
        assert.equal(first.cacheHit, false);
        assert.equal(second.cacheHit, true);
        assert.deepEqual(second.vector, first.vector);
    });

    it('persists embeddings on flush and hits the disk cache in a new session', async () => {
        const first = makeSession();
        const original = await first.embed('discount and tax edge cases');
        await first.flush();

        const second = makeSession();
        const cached = await second.embed('discount and tax edge cases');
        assert.equal(cached.cacheHit, true);
        assert.deepEqual(cached.vector, original.vector);
    });

    it('writes all buffered embeddings in a single flush', async () => {
        const session = makeSession();
        await session.embed('one');
        await session.embed('two');
        await session.embed('three');

        const cacheFile = getCacheFile(cacheDir);
        await assert.rejects(fs.stat(cacheFile), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');

        await session.flush();
        const cache = await loadCache(cacheFile);
        assert.equal(Object.keys(cache).length, 3);
    });

    it('does not touch the cache when skipCache is set', async () => {
        const session = new EmbeddingSession({
            model: 'stub-model',
            cacheDir,
            skipCache: true,
        });
        await session.embed('uncached text');
        await session.flush();
        await assert.rejects(
            fs.stat(getCacheFile(cacheDir)),
            (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
        );
    });

    it('rejects a session without a model path', () => {
        assert.throws(
            () => new EmbeddingSession({ model: '', cacheDir }),
            /local GGUF embedding model path is required/
        );
    });

    // The README promises cache writes are best-effort and never fail the command.
    it('keeps working when the cache cannot be written', async () => {
        const blocked = path.join(cacheDir, 'blocked');
        await fs.writeFile(blocked, 'a file where a directory is expected', 'utf8');
        const session = new EmbeddingSession({ model: 'stub-model', cacheDir: blocked });

        const result = await session.embed('unwritable cache');
        await session.flush();

        assert.equal(result.cacheHit, false);
        assert.ok(result.vector.length > 0);
    });

    it('retries the buffered write on a later flush', async () => {
        const target = path.join(cacheDir, 'retry');
        const blocker = path.join(target, 'embeddings.json');
        await fs.mkdir(blocker, { recursive: true });
        const session = new EmbeddingSession({ model: 'stub-model', cacheDir: target });
        await session.embed('deferred');
        await session.flush();

        await fs.rmdir(blocker);
        await session.flush();

        assert.equal(Object.keys(await loadCache(getCacheFile(target))).length, 1);
    });

    it('reports zero cache entries for a missing or unreadable cache', async () => {
        assert.equal(await getCacheEntryCount(path.join(cacheDir, 'never-created')), 0);

        const malformed = path.join(cacheDir, 'malformed');
        await fs.mkdir(malformed, { recursive: true });
        await fs.writeFile(getCacheFile(malformed), 'not json', 'utf8');
        assert.equal(await getCacheEntryCount(malformed), 0);
    });

    it('counts persisted cache entries', async () => {
        const session = makeSession();
        await session.embed('one');
        await session.embed('two');
        await session.flush();

        assert.equal(await getCacheEntryCount(cacheDir), 2);
    });

    it('keys the cache by model so a model swap misses', async () => {
        const first = new EmbeddingSession({ model: 'model-a', cacheDir });
        await first.embed('shared text');
        await first.flush();

        const second = new EmbeddingSession({ model: 'model-b', cacheDir });
        assert.equal((await second.embed('shared text')).cacheHit, false);
    });

    it('createEmbedding embeds and persists in one call', async () => {
        const result = await createEmbedding({
            text: 'standalone embedding',
            model: 'stub-model',
            cacheDir,
        });
        assert.equal(result.cacheHit, false);

        const cache = await loadCache(getCacheFile(cacheDir));
        assert.equal(Object.keys(cache).length, 1);
    });
});
